/** Transport-agnostic outbound messaging, so the runner never imports Telegram. */
import type { EventBus } from '../core/events.js';

export interface ApprovalRequest {
  taskId: number;
  chatId: number;
  title: string;
  project: string;
  reason: string;
  details: string[];
}

export interface Notifier {
  sendMessage(chatId: number, text: string): Promise<void>;
  requestApproval(request: ApprovalRequest): Promise<void>;
}

/** Discards everything. Used by tests and by CLI commands that run headless. */
export const nullNotifier: Notifier = {
  async sendMessage() {},
  async requestApproval() {},
};

/**
 * Deliver to every enabled interface. Message failure on one channel must not
 * hide the message from the other — but an approval REQUEST is different: the
 * task must proceed if at least one interface heard it, and fail only when
 * nobody did.
 */
export function fanOutNotifier(targets: Notifier[]): Notifier {
  return {
    async sendMessage(chatId, text) {
      await Promise.allSettled(targets.map((t) => t.sendMessage(chatId, text)));
    },
    async requestApproval(request) {
      const results = await Promise.allSettled(targets.map((t) => t.requestApproval(request)));
      if (targets.length > 0 && results.every((r) => r.status === 'rejected')) {
        throw new Error('No interface could deliver the approval request');
      }
    },
  };
}

export interface ProgressReporterOptions {
  chatId: number;
  taskId: number;
  notifier: Notifier;
  /** When present, every delivered line is also published for live UIs. */
  bus?: EventBus;
  /** Minimum gap between outbound progress messages (Telegram rate safety). */
  minIntervalMs?: number;
}

/** Who produced a progress line: the coding agent itself, or this application. */
export type ProgressSource = 'agent' | 'system';

/**
 * Collapses a firehose of CLI events into a small number of readable Telegram
 * updates: identical/near-identical phases are merged, and messages are rate
 * limited. The most recent pending phase is always eventually delivered.
 */
export class ProgressReporter {
  private lastSentAt = 0;
  private lastSentText: string | null = null;
  private pending: string | null = null;
  private pendingSource: ProgressSource = 'system';
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly minIntervalMs: number;

  constructor(private readonly options: ProgressReporterOptions) {
    this.minIntervalMs = options.minIntervalMs ?? 9_000;
  }

  /** Queue a progress line. Duplicate consecutive phases are dropped. */
  update(text: string, source: ProgressSource = 'system'): void {
    if (this.closed) return;
    const trimmed = text.trim();
    if (!trimmed || trimmed === this.lastSentText || trimmed === this.pending) return;

    this.pending = trimmed;
    this.pendingSource = source;
    this.schedule();
  }

  /** Send immediately, bypassing aggregation (milestones, warnings). */
  async milestone(text: string): Promise<void> {
    if (this.closed) return;
    this.pending = null;
    this.clearTimer();
    await this.deliver(text, 'system');
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastSentAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      const text = this.pending;
      const source = this.pendingSource;
      this.pending = null;
      if (text) void this.deliver(text, source);
    }, wait);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async deliver(text: string, source: ProgressSource): Promise<void> {
    this.lastSentAt = Date.now();
    this.lastSentText = text;
    this.options.bus?.publish('task-progress', this.options.taskId, { text, source });
    try {
      // chatId 0 means "no Telegram chat" (web-originated task): the bus above
      // is the delivery; there is nobody to message.
      if (this.options.chatId !== 0) {
        await this.options.notifier.sendMessage(this.options.chatId, text);
      }
    } catch {
      // A failed progress ping must never abort the task.
    }
  }

  /** Flush any pending update and stop scheduling. */
  async close(): Promise<void> {
    this.clearTimer();
    const text = this.pending;
    const source = this.pendingSource;
    this.pending = null;
    this.closed = true;
    if (text) await this.deliver(text, source);
  }
}
