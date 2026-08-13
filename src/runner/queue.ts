import { createLogger, errorMessage } from '../core/logger.js';
import type { TaskRepository } from '../db/taskRepository.js';
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
  private running = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private draining = false;

  constructor(
    private readonly tasks: TaskRepository,
    private readonly runner: TaskRunner,
    private readonly options: QueueOptions,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;

    const recovered = this.tasks.recoverOrphans();
    if (recovered.length > 0) {
      log.warn('Re-queued tasks interrupted by a previous shutdown', { count: recovered.length });
    }

    const interval = this.options.pollIntervalMs ?? 1_500;
    this.timer = setInterval(() => void this.drain(), interval);
    this.timer.unref?.();
    void this.drain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const taskId of this.running) this.runner.cancel(taskId);
  }

  /** Nudge the scheduler after enqueuing work. */
  kick(): void {
    void this.drain();
  }

  activeCount(): number {
    return this.running.size;
  }

  activeIds(): number[] {
    return [...this.running];
  }

  private async drain(): Promise<void> {
    if (this.stopped || this.draining) return;
    this.draining = true;
    try {
      while (this.running.size < this.options.maxConcurrent) {
        const task = this.tasks.claimNextQueued(process.pid);
        if (!task) break;

        this.running.add(task.id);
        void this.runner
          .run(task)
          .catch((err) => log.error('Unhandled task failure', { taskId: task.id, error: errorMessage(err) }))
          .finally(() => {
            this.running.delete(task.id);
            if (!this.stopped) void this.drain();
          });
      }
    } finally {
      this.draining = false;
    }
  }
}
