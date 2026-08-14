import { createLogger, errorMessage } from '../core/logger.js';
import type { TaskRepository } from '../db/taskRepository.js';
import type { Task } from '../domain/task.js';
import type { TaskRunner } from './taskRunner.js';

const log = createLogger('queue');

export interface QueueOptions {
  maxConcurrent: number;
  pollIntervalMs?: number;
}

/**
 * Single-process scheduler. Concurrency and duplicate execution are guarded by
 * the atomic `claimNextQueued` update, so a task can only ever be picked up once.
 */
export class TaskQueue {
  private running = new Map<number, Promise<unknown>>();
  private busyProjects = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private draining = false;
  private lastRecovery: { requeued: Task[]; abandoned: Task[] } = { requeued: [], abandoned: [] };

  /** What the last start() recovered, for the online banner. */
  recoveryReport(): { requeued: Task[]; abandoned: Task[] } {
    return this.lastRecovery;
  }

  constructor(
    private readonly tasks: TaskRepository,
    private readonly runner: TaskRunner,
    private readonly options: QueueOptions,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;

    const recovered = this.tasks.recoverOrphans();
    if (recovered.requeued.length > 0) {
      log.warn('Re-queued tasks interrupted by a previous shutdown', { count: recovered.requeued.length });
    }
    if (recovered.abandoned.length > 0) {
      log.warn('Abandoned tasks interrupted too many times', { count: recovered.abandoned.length });
    }
    this.lastRecovery = recovered;

    const interval = this.options.pollIntervalMs ?? 1_500;
    this.timer = setInterval(() => void this.drain(), interval);
    this.timer.unref?.();
    void this.drain();
  }

  /** Stop scheduling and wait (bounded) for in-flight tasks to unwind. */
  async stop(graceMs = 20_000): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const taskId of this.running.keys()) this.runner.cancel(taskId);

    const inFlight = [...this.running.values()];
    if (inFlight.length === 0) return;

    // Bounded: a wedged task must not prevent the agent from exiting.
    await Promise.race([
      Promise.allSettled(inFlight),
      new Promise((resolve) => setTimeout(resolve, graceMs).unref?.()),
    ]);
  }

  /** Nudge the scheduler after enqueuing work. */
  kick(): void {
    void this.drain();
  }

  activeCount(): number {
    return this.running.size;
  }

  activeIds(): number[] {
    return [...this.running.keys()];
  }

  private async drain(): Promise<void> {
    if (this.stopped || this.draining) return;
    this.draining = true;
    try {
      while (this.running.size < this.options.maxConcurrent) {
        // A database error here (locked, full, corrupt) must not escape as an
        // unhandled rejection and silently kill the scheduling loop.
        let task;
        try {
          // Two tasks in one repository would share a working tree and index, so
          // a project already running is skipped rather than claimed.
          task = this.tasks.claimNextQueued(process.pid, [...this.busyProjects]);
        } catch (err) {
          log.error('Could not claim a task; will retry on the next tick', { error: errorMessage(err) });
          break;
        }
        if (!task) break;

        this.busyProjects.add(task.projectId);
        const promise = this.runner
          .run(task)
          .catch((err) => log.error('Unhandled task failure', { taskId: task.id, error: errorMessage(err) }))
          .finally(() => {
            this.running.delete(task.id);
            this.busyProjects.delete(task.projectId);
            if (!this.stopped) void this.drain();
          });
        this.running.set(task.id, promise);
      }
    } finally {
      this.draining = false;
    }
  }
}
