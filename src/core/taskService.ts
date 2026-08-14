/**
 * The one place a task may be submitted, cancelled or retried.
 *
 * Telegram and the web UI are thin clients of this service. Neither may carry
 * its own copy of the queue cap, the risk gate or the approval flow — a second
 * copy is where the two interfaces would start to disagree, and where a
 * security check could be present in one and missing in the other.
 */

import { isTerminal, type Task, type TaskOrigin } from '../domain/task.js';
import type { TaskRepository } from '../db/taskRepository.js';
import type { ProjectRegistry } from '../projects/registry.js';
import type { TaskQueue } from '../runner/queue.js';
import type { TaskRunner } from '../runner/taskRunner.js';
import type { ApprovalService } from '../approval/service.js';
import type { Notifier } from '../notify/notifier.js';
import type { AppConfig } from './config.js';
import { assessRisk } from '../approval/risk.js';
import { createLogger, errorMessage } from './logger.js';

const log = createLogger('tasks');

export const MAX_PROMPT_LENGTH = 4000;
export const MAX_QUEUED_TASKS = 20;

export interface SubmitInput {
  origin: TaskOrigin;
  /** Telegram operator id, or 0 for the web operator (single-user install). */
  userId: number;
  /** Telegram chat to report into; 0 when the task did not come from Telegram. */
  chatId: number;
  projectId: string;
  prompt: string;
  /** Per-task model override. Validated by the caller against the catalogue. */
  model?: string | null;
}

export type SubmitResult =
  | { ok: true; task: Task; awaitingApproval: boolean }
  | { ok: false; error: string };

export type ActionResult = { ok: true; message: string; taskId?: number } | { ok: false; error: string };

export interface TaskServiceDeps {
  config: AppConfig;
  tasks: TaskRepository;
  projects: ProjectRegistry;
  queue: TaskQueue;
  runner: TaskRunner;
  approvals: ApprovalService;
  notifier: Notifier;
}

export class TaskService {
  /** Detached approval flows, awaited on shutdown so decisions are persisted. */
  private readonly pendingFlows = new Set<Promise<void>>();

  constructor(private readonly deps: TaskServiceDeps) {}

  submit(input: SubmitInput): SubmitResult {
    const { tasks, projects, config, queue } = this.deps;

    const prompt = input.prompt.trim();
    if (!prompt) return { ok: false, error: 'The task description is empty.' };
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return { ok: false, error: `That task description is too long (max ${MAX_PROMPT_LENGTH} characters).` };
    }

    projects.load();
    const project = projects.getById(input.projectId);
    if (!project) return { ok: false, error: 'That project is not registered.' };

    // A runaway client (or a fat-fingered burst) must not be able to fill the
    // queue and the database.
    const queued = tasks.listByStatus('QUEUED').length + tasks.listByStatus('WAITING_APPROVAL').length;
    if (queued >= MAX_QUEUED_TASKS) {
      return { ok: false, error: `There are already ${queued} tasks waiting. Let them finish or cancel some first.` };
    }

    const risk = assessRisk(prompt);
    const needsApproval = config.safety.requireApprovalForDangerousActions && risk.level === 'elevated';

    const task = tasks.create({
      userId: input.userId,
      chatId: input.chatId,
      projectId: input.projectId,
      prompt,
      approvalRequired: needsApproval,
      approvalReason: risk.reason,
      origin: input.origin,
      model: input.model ?? null,
    });

    if (needsApproval) {
      // Fire-and-forget: a Telegram handler must never block on the decision.
      this.detach(this.runApprovalFlow(task.id, input.chatId, project.name, risk.reason, prompt));
      return { ok: true, task, awaitingApproval: true };
    }

    queue.kick();
    return { ok: true, task, awaitingApproval: false };
  }

  /**
   * Cancel wherever the task currently is: running, queued, or parked on a
   * pre-execution approval. `byUserId` undefined means an authenticated web
   * operator, who on a single-user install may answer anything.
   */
  cancel(id: number, byUserId?: number): ActionResult {
    const { tasks, runner, approvals } = this.deps;
    const task = tasks.get(id);
    if (!task) return { ok: false, error: `Task #${id} not found.` };
    if (isTerminal(task.status)) return { ok: false, error: `Task #${id} already finished (${task.status}).` };

    if (runner.isRunning(id)) {
      runner.cancel(id);
      return { ok: true, message: `Cancelling task #${id}…`, taskId: id };
    }

    approvals.resolve(id, 'REJECTED', byUserId);
    const latest = tasks.get(id);
    if (latest && !isTerminal(latest.status)) {
      tasks.transition(id, 'CANCELLED', { error: 'Cancelled by operator before execution.' });
    }
    return { ok: true, message: `Task #${id} cancelled.`, taskId: id };
  }

  retry(id: number): ActionResult {
    const { tasks, projects, config, queue } = this.deps;
    const task = tasks.get(id);
    if (!task) return { ok: false, error: `Task #${id} not found.` };
    if (!isTerminal(task.status)) return { ok: false, error: `Task #${id} is still ${task.status}.` };

    projects.load();
    const project = projects.getById(task.projectId);
    if (!project) return { ok: false, error: 'That project is no longer registered.' };

    // A double-tapped /retry (or two interfaces retrying at once) must not
    // produce two live copies of the same request.
    const statuses = ['QUEUED', 'WAITING_APPROVAL', 'RUNNING', 'TESTING'] as const;
    for (const status of statuses) {
      const clone = tasks.listByStatus(status).find((t) => t.projectId === task.projectId && t.prompt === task.prompt);
      if (clone) return { ok: false, error: `Task #${clone.id} is already ${clone.status} for the same request.` };
    }

    // Re-assess: a retry must not launder a previously rejected or
    // risk-flagged prompt past the approval gate.
    const risk = assessRisk(task.prompt);
    const needsApproval = config.safety.requireApprovalForDangerousActions && risk.level === 'elevated';

    const created = tasks.create({
      userId: task.userId,
      chatId: task.chatId,
      projectId: task.projectId,
      prompt: task.prompt,
      approvalRequired: needsApproval,
      approvalReason: risk.reason,
      origin: task.origin,
      model: task.model,
    });
    tasks.addEvent(created.id, 'retry', `Re-queued from task #${id}`);

    if (needsApproval) {
      this.detach(this.runApprovalFlow(created.id, task.chatId, project.name, risk.reason, task.prompt));
      return { ok: true, message: `Re-queued as task #${created.id} — approval still required.`, taskId: created.id };
    }

    queue.kick();
    return { ok: true, message: `Re-queued as task #${created.id}.`, taskId: created.id };
  }

  /** Move a queued task to the front. Running/finished tasks are immovable. */
  promote(id: number): ActionResult {
    const task = this.deps.tasks.get(id);
    if (!task) return { ok: false, error: `Task #${id} not found.` };
    if (!this.deps.tasks.promote(id)) {
      return { ok: false, error: `Task #${id} is ${task.status}, not QUEUED — only queued tasks can be reordered.` };
    }
    this.deps.queue.kick();
    return { ok: true, message: `Task #${id} moved to the front of the queue.`, taskId: id };
  }

  /** Wait for detached approval flows so shutdown persists their outcomes. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pendingFlows]);
  }

  private detach(flow: Promise<void>): void {
    this.pendingFlows.add(flow);
    void flow.finally(() => this.pendingFlows.delete(flow));
  }

  private async runApprovalFlow(
    taskId: number,
    chatId: number,
    projectName: string,
    reason: string | null,
    prompt: string,
  ): Promise<void> {
    const { tasks, queue, approvals, notifier } = this.deps;
    try {
      const outcome = await approvals.request({
        taskId,
        chatId,
        title: 'Potentially sensitive task',
        project: projectName,
        reason: reason ?? 'Flagged by the risk classifier',
        details: [`Request: ${prompt.slice(0, 300)}`],
      });

      const current = tasks.get(taskId);
      if (!current || isTerminal(current.status)) return;

      if (outcome !== 'APPROVED') {
        tasks.transition(taskId, 'CANCELLED', {
          error: outcome === 'REJECTED' ? 'Rejected by operator.' : 'Approval expired.',
        });
        if (chatId !== 0) {
          await notifier.sendMessage(chatId, `🚫 Task #${taskId} ${outcome.toLowerCase()} — nothing was executed.`);
        }
        return;
      }

      tasks.transition(taskId, 'QUEUED');
      queue.kick();
    } catch (err) {
      log.error('Approval flow failed', { taskId, error: errorMessage(err) });
      try {
        const current = tasks.get(taskId);
        if (current && !isTerminal(current.status)) {
          tasks.transition(taskId, 'FAILED', { error: 'Approval flow failed.' });
        }
      } catch {
        // Nothing further we can do.
      }
    }
  }
}
