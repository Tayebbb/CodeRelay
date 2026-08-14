import type { ApprovalStatus } from '../domain/task.js';
import type { ApprovalRequest, Notifier } from '../notify/notifier.js';
import type { TaskRepository } from '../db/taskRepository.js';

type Waiter = {
  resolve: (status: ApprovalStatus) => void;
  timer: NodeJS.Timeout;
  /** Only this operator may answer. */
  ownerUserId: number;
  cleanup: () => void;
};

export type ApprovalOutcome = Extract<ApprovalStatus, 'APPROVED' | 'REJECTED' | 'EXPIRED'>;

export type ResolveResult = 'resolved' | 'not-pending' | 'forbidden';

export interface RequestOptions {
  /** Cancels the wait (task cancellation, shutdown). Resolves as REJECTED. */
  signal?: AbortSignal;
}

/**
 * Human-in-the-loop gate. A task that needs approval parks here until the
 * operator taps Approve/Reject in Telegram, the request expires, or the task is
 * cancelled.
 *
 * NEVER `await` this from inside a Telegram update handler. grammY processes
 * updates strictly sequentially, so blocking a handler on an approval prevents
 * the very callback_query that would resolve it from ever being delivered. The
 * bot fires-and-forgets; the task runner awaits it safely because it runs
 * outside the update loop.
 */
export class ApprovalService {
  private waiters = new Map<number, Waiter>();

  constructor(
    private readonly tasks: TaskRepository,
    private readonly notifier: Notifier,
    private readonly timeoutMs: number,
  ) {}

  /** Ask the operator and wait for an answer. */
  async request(request: ApprovalRequest, options: RequestOptions = {}): Promise<ApprovalOutcome> {
    const task = this.tasks.get(request.taskId);
    if (!task) return 'REJECTED';
    if (options.signal?.aborted) return 'REJECTED';

    this.tasks.setApproval(request.taskId, 'PENDING');
    this.tasks.addEvent(request.taskId, 'approval', `Approval requested: ${request.reason}`);

    const promise = new Promise<ApprovalOutcome>((resolve) => {
      const settle = (outcome: ApprovalOutcome, status: ApprovalStatus, note: string) => {
        const waiter = this.waiters.get(request.taskId);
        if (!waiter) return;
        waiter.cleanup();
        this.waiters.delete(request.taskId);
        this.tasks.setApproval(request.taskId, status);
        this.tasks.addEvent(request.taskId, 'approval', note);
        resolve(outcome);
      };

      const timer = setTimeout(() => settle('EXPIRED', 'EXPIRED', 'Approval request expired'), this.timeoutMs);
      timer.unref?.();

      const onAbort = () => settle('REJECTED', 'REJECTED', 'Approval abandoned (task cancelled or agent stopping)');
      options.signal?.addEventListener('abort', onAbort, { once: true });

      this.waiters.set(request.taskId, {
        resolve: resolve as (s: ApprovalStatus) => void,
        timer,
        ownerUserId: task.userId,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
        },
      });
    });

    try {
      await this.notifier.requestApproval(request);
    } catch (err) {
      // The waiter was registered before this call; leaving it behind would leak
      // a live timer and make isPending() lie forever.
      const waiter = this.waiters.get(request.taskId);
      waiter?.cleanup();
      this.waiters.delete(request.taskId);
      this.tasks.setApproval(request.taskId, 'REJECTED');
      this.tasks.addEvent(request.taskId, 'approval', `Could not deliver approval request: ${String(err)}`);
      return 'REJECTED';
    }
    return promise;
  }

  /**
   * Resolve a pending request. Side effects happen only after the request is
   * confirmed to exist and to belong to the deciding operator — writing an event
   * for an unknown id would violate the task_events foreign key, throw, and
   * abort the Telegram handler before it ever replies.
   */
  resolve(taskId: number, decision: 'APPROVED' | 'REJECTED', byUserId?: number): ResolveResult {
    const waiter = this.waiters.get(taskId);
    if (!waiter) return 'not-pending';
    if (byUserId !== undefined && waiter.ownerUserId !== 0 && waiter.ownerUserId !== byUserId) {
      return 'forbidden';
    }

    waiter.cleanup();
    this.waiters.delete(taskId);
    this.tasks.setApproval(taskId, decision);
    this.tasks.addEvent(taskId, 'approval', `Operator decision: ${decision}`);
    waiter.resolve(decision);
    return 'resolved';
  }

  isPending(taskId: number): boolean {
    return this.waiters.has(taskId);
  }

  pendingIds(): number[] {
    return [...this.waiters.keys()];
  }

  /** Abandon every outstanding request (shutdown). */
  cancelAll(): void {
    for (const [taskId, waiter] of [...this.waiters]) {
      waiter.cleanup();
      this.waiters.delete(taskId);
      // Persist the outcome too, or the row keeps claiming PENDING forever and
      // the audit trail lies about what happened.
      try {
        this.tasks.setApproval(taskId, 'EXPIRED');
        this.tasks.addEvent(taskId, 'approval', 'Abandoned: agent shutting down');
      } catch {
        // The database may already be closing.
      }
      waiter.resolve('EXPIRED');
    }
  }
}
