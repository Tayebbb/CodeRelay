import type { ApprovalStatus } from '../domain/task.js';
import type { ApprovalRequest, Notifier } from '../notify/notifier.js';
import type { TaskRepository } from '../db/taskRepository.js';

type Waiter = {
  resolve: (status: ApprovalStatus) => void;
  timer: NodeJS.Timeout;
};

export type ApprovalOutcome = Extract<ApprovalStatus, 'APPROVED' | 'REJECTED' | 'EXPIRED'>;

/**
 * Human-in-the-loop gate. A task that needs approval parks here until the
 * operator taps Approve/Reject in Telegram, or the request expires.
 */
export class ApprovalService {
  private waiters = new Map<number, Waiter>();

  constructor(
    private readonly tasks: TaskRepository,
    private readonly notifier: Notifier,
    private readonly timeoutMs: number,
  ) {}

  /** Ask the operator and block until they answer. */
  async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    this.tasks.setApproval(request.taskId, 'PENDING');
    this.tasks.addEvent(request.taskId, 'approval', `Approval requested: ${request.reason}`);

    const promise = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(request.taskId);
        this.tasks.setApproval(request.taskId, 'EXPIRED');
        this.tasks.addEvent(request.taskId, 'approval', 'Approval request expired');
        resolve('EXPIRED');
      }, this.timeoutMs);
      timer.unref?.();
      this.waiters.set(request.taskId, { resolve: resolve as (s: ApprovalStatus) => void, timer });
    });

    await this.notifier.requestApproval(request);
    return promise;
  }

  /** Resolve a pending request. Returns false if nothing was waiting. */
  resolve(taskId: number, decision: 'APPROVED' | 'REJECTED'): boolean {
    const waiter = this.waiters.get(taskId);
    this.tasks.setApproval(taskId, decision);
    this.tasks.addEvent(taskId, 'approval', `Operator decision: ${decision}`);
    if (!waiter) return false;

    clearTimeout(waiter.timer);
    this.waiters.delete(taskId);
    waiter.resolve(decision);
    return true;
  }

  isPending(taskId: number): boolean {
    return this.waiters.has(taskId);
  }

  cancelAll(): void {
    for (const [taskId, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve('EXPIRED');
      this.waiters.delete(taskId);
    }
  }
}
