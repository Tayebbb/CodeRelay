/** Task lifecycle. Transitions are validated by `canTransition`. */
export const TASK_STATUSES = [
  'QUEUED',
  'RUNNING',
  'WAITING_APPROVAL',
  'TESTING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  QUEUED: ['RUNNING', 'WAITING_APPROVAL', 'CANCELLED', 'FAILED', 'TIMED_OUT'],
  WAITING_APPROVAL: ['RUNNING', 'QUEUED', 'CANCELLED', 'TIMED_OUT', 'FAILED'],
  // RUNNING -> QUEUED covers crash recovery re-queueing on restart.
  RUNNING: ['TESTING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'QUEUED'],
  TESTING: ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'WAITING_APPROVAL'],
  COMPLETED: [],
  FAILED: ['QUEUED'],
  CANCELLED: ['QUEUED'],
  TIMED_OUT: ['QUEUED'],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Invalid task transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export type ApprovalStatus = 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export interface TaskUsage {
  /** AI credits (a.k.a. premium requests) reported by the Copilot CLI. */
  aiCredits: number;
  outputTokens: number;
  copilotSessionIds: string[];
  /** Copilot runs that finished without telling us what they cost. */
  unreportedRuns: number;
}

export interface VerificationResult {
  kind: 'test' | 'build';
  command: string;
  exitCode: number | null;
  passed: boolean;
  durationMs: number;
  summary: string;
}

export interface TaskResultDetail {
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
  verifications: VerificationResult[];
  summary: string;
  checkpointRef?: string;
}

/** Which interface created the task. Both observe the same record. */
export type TaskOrigin = 'telegram' | 'web';

export interface Task {
  id: number;
  userId: number;
  chatId: number;
  projectId: string;
  prompt: string;
  status: TaskStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  result: TaskResultDetail | null;
  error: string | null;
  commitHash: string | null;
  branch: string | null;
  retryCount: number;
  approvalRequired: boolean;
  approvalStatus: ApprovalStatus;
  approvalReason: string | null;
  usage: TaskUsage;
  /** Correlates with the running process so a restart can detect orphans. */
  runnerPid: number | null;
  origin: TaskOrigin;
  /** Per-task model override; null uses the configured default. */
  model: string | null;
  /** Queue precedence: higher first, then FIFO by id. 0 = normal. */
  priority: number;
}

export interface NewTask {
  userId: number;
  chatId: number;
  projectId: string;
  prompt: string;
  approvalRequired: boolean;
  approvalReason: string | null;
  origin?: TaskOrigin;
  model?: string | null;
}

export const EMPTY_USAGE: TaskUsage = { aiCredits: 0, outputTokens: 0, copilotSessionIds: [], unreportedRuns: 0 };

export function statusEmoji(status: TaskStatus): string {
  switch (status) {
    case 'QUEUED':
      return '🕒';
    case 'RUNNING':
      return '⚙️';
    case 'WAITING_APPROVAL':
      return '⚠️';
    case 'TESTING':
      return '🧪';
    case 'COMPLETED':
      return '✅';
    case 'FAILED':
      return '❌';
    case 'CANCELLED':
      return '🚫';
    case 'TIMED_OUT':
      return '⌛';
  }
}
