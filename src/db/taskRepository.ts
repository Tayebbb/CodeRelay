import type { Db } from './database.js';
import {
  canTransition,
  EMPTY_USAGE,
  InvalidTransitionError,
  isTerminal,
  type ApprovalStatus,
  type NewTask,
  type Task,
  type TaskResultDetail,
  type TaskStatus,
  type TaskUsage,
} from '../domain/task.js';
import { redact } from '../core/redact.js';

interface TaskRow {
  id: number;
  user_id: number;
  chat_id: number;
  project_id: string;
  prompt: string;
  status: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  result_json: string | null;
  error: string | null;
  commit_hash: string | null;
  branch: string | null;
  retry_count: number;
  approval_required: number;
  approval_status: string;
  approval_reason: string | null;
  usage_json: string;
  runner_pid: number | null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    userId: row.user_id,
    chatId: row.chat_id,
    projectId: row.project_id,
    prompt: row.prompt,
    status: row.status as TaskStatus,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    result: parseJson<TaskResultDetail | null>(row.result_json, null),
    error: row.error,
    commitHash: row.commit_hash,
    branch: row.branch,
    retryCount: row.retry_count,
    approvalRequired: row.approval_required === 1,
    approvalStatus: row.approval_status as ApprovalStatus,
    approvalReason: row.approval_reason,
    usage: { ...EMPTY_USAGE, ...parseJson<Partial<TaskUsage>>(row.usage_json, {}) },
    runnerPid: row.runner_pid,
  };
}

export interface TaskEvent {
  id: number;
  taskId: number;
  ts: number;
  kind: string;
  message: string;
  meta: Record<string, unknown> | null;
}

export class TaskRepository {
  constructor(private readonly db: Db) {}

  create(input: NewTask): Task {
    const now = Date.now();
    const status: TaskStatus = input.approvalRequired ? 'WAITING_APPROVAL' : 'QUEUED';
    const stmt = this.db.prepare(
      `INSERT INTO tasks (user_id, chat_id, project_id, prompt, status, created_at,
                          approval_required, approval_status, approval_reason, usage_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const info = stmt.run(
      input.userId,
      input.chatId,
      input.projectId,
      redact(input.prompt),
      status,
      now,
      input.approvalRequired ? 1 : 0,
      input.approvalRequired ? 'PENDING' : 'NONE',
      input.approvalReason,
      JSON.stringify(EMPTY_USAGE),
    );
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  list(limit = 20): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT ?').all(limit) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  listByStatus(status: TaskStatus): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY id ASC')
      .all(status) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  countActive(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('RUNNING','TESTING')")
      .get() as { n: number };
    return row.n;
  }

  /** Claim the oldest queued task atomically; returns null if none is available. */
  claimNextQueued(pid: number): Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'QUEUED' ORDER BY id ASC LIMIT 1")
      .get() as TaskRow | undefined;
    if (!row) return null;

    const info = this.db
      .prepare("UPDATE tasks SET status = 'RUNNING', started_at = ?, runner_pid = ? WHERE id = ? AND status = 'QUEUED'")
      .run(Date.now(), pid, row.id);
    if (info.changes === 0) return null;

    this.addEvent(row.id, 'status', 'Task claimed by runner');
    return this.get(row.id);
  }

  transition(id: number, to: TaskStatus, patch: Partial<Task> = {}): Task {
    const current = this.get(id);
    if (!current) throw new Error(`Task ${id} not found`);
    if (current.status !== to && !canTransition(current.status, to)) {
      throw new InvalidTransitionError(current.status, to);
    }

    const fields: string[] = ['status = ?'];
    const values: Array<string | number | null> = [to];

    if (to === 'RUNNING' && current.startedAt === null) {
      fields.push('started_at = ?');
      values.push(Date.now());
    }
    if (isTerminal(to)) {
      fields.push('completed_at = ?', 'runner_pid = ?');
      values.push(Date.now(), null);
    }
    if (patch.error !== undefined) {
      fields.push('error = ?');
      values.push(patch.error === null ? null : redact(patch.error).slice(0, 8000));
    }
    if (patch.result !== undefined) {
      fields.push('result_json = ?');
      values.push(patch.result === null ? null : JSON.stringify(patch.result));
    }
    if (patch.commitHash !== undefined) {
      fields.push('commit_hash = ?');
      values.push(patch.commitHash);
    }
    if (patch.branch !== undefined) {
      fields.push('branch = ?');
      values.push(patch.branch);
    }
    if (patch.approvalStatus !== undefined) {
      fields.push('approval_status = ?');
      values.push(patch.approvalStatus);
    }
    if (patch.approvalReason !== undefined) {
      fields.push('approval_reason = ?');
      values.push(patch.approvalReason);
    }
    if (patch.retryCount !== undefined) {
      fields.push('retry_count = ?');
      values.push(patch.retryCount);
    }
    if (patch.usage !== undefined) {
      fields.push('usage_json = ?');
      values.push(JSON.stringify(patch.usage));
    }

    values.push(id);
    this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    this.addEvent(id, 'status', `${current.status} -> ${to}`);
    return this.get(id)!;
  }

  updateUsage(id: number, usage: TaskUsage, model?: string): void {
    const previous = this.get(id)?.usage ?? EMPTY_USAGE;
    this.db.prepare('UPDATE tasks SET usage_json = ? WHERE id = ?').run(JSON.stringify(usage), id);

    const delta = usage.aiCredits - previous.aiCredits;
    if (delta > 0) {
      this.db
        .prepare('INSERT INTO usage_ledger (task_id, ts, credits, model) VALUES (?, ?, ?, ?)')
        .run(id, Date.now(), delta, model ?? null);
    }
  }

  /** AI credits consumed in the trailing `windowMs` milliseconds. */
  creditsUsedSince(windowMs: number): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(credits), 0) AS total FROM usage_ledger WHERE ts >= ?')
      .get(Date.now() - windowMs) as { total: number };
    return row.total;
  }

  setApproval(id: number, status: ApprovalStatus): void {
    this.db.prepare('UPDATE tasks SET approval_status = ? WHERE id = ?').run(status, id);
  }

  incrementRetry(id: number): number {
    this.db.prepare('UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?').run(id);
    return this.get(id)!.retryCount;
  }

  addEvent(taskId: number, kind: string, message: string, meta?: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO task_events (task_id, ts, kind, message, meta) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, Date.now(), kind, redact(message).slice(0, 4000), meta ? redact(JSON.stringify(meta)) : null);
  }

  events(taskId: number, limit = 200): TaskEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id ASC LIMIT ?')
      .all(taskId, limit) as Array<{
      id: number;
      task_id: number;
      ts: number;
      kind: string;
      message: string;
      meta: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      ts: r.ts,
      kind: r.kind,
      message: r.message,
      meta: parseJson<Record<string, unknown> | null>(r.meta, null),
    }));
  }

  /**
   * Re-queue tasks left mid-flight by a crash. Guards against duplicate execution
   * because a task can only be claimed via `claimNextQueued`.
   */
  recoverOrphans(): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE status IN ('RUNNING','TESTING')")
      .all() as unknown as TaskRow[];
    const recovered: Task[] = [];
    for (const row of rows) {
      this.db
        .prepare("UPDATE tasks SET status = 'QUEUED', runner_pid = NULL, started_at = NULL WHERE id = ?")
        .run(row.id);
      this.addEvent(row.id, 'recovery', 'Runner restarted while task was in flight; re-queued');
      recovered.push(this.get(row.id)!);
    }
    return recovered;
  }

  /** Idempotency guard for Telegram updates. Returns false when already seen. */
  markUpdateProcessed(updateId: number): boolean {
    try {
      this.db.prepare('INSERT INTO processed_updates (update_id, ts) VALUES (?, ?)').run(updateId, Date.now());
      return true;
    } catch {
      return false;
    }
  }

  pruneProcessedUpdates(olderThanMs = 24 * 60 * 60 * 1000): void {
    this.db.prepare('DELETE FROM processed_updates WHERE ts < ?').run(Date.now() - olderThanMs);
  }
}
