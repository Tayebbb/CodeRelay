/** Transport-agnostic outbound messaging, so the runner never imports Telegram. */
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

export interface ProgressReporterOptions {
  chatId: number;
  taskId: number;
  notifier: Notifier;
  /** Minimum gap between outbound progress messages (Telegram rate safety). */
  minIntervalMs?: number;
}

/**
 * Collapses a firehose of CLI events into a small number of readable Telegram
 * updates: identical/near-identical phases are merged, and messages are rate
 * limited. The most recent pending phase is always eventually delivered.
 */
export class ProgressReporter {
  private lastSentAt = 0;
  private lastSentText: string | null = null;
  private pending: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly minIntervalMs: number;

  constructor(private readonly options: ProgressReporterOptions) {
    this.minIntervalMs = options.minIntervalMs ?? 9_000;
  }

  /** Queue a progress line. Duplicate consecutive phases are dropped. */
  update(text: string): void {
    if (this.closed) return;
    const trimmed = text.trim();
    if (!trimmed || trimmed === this.lastSentText || trimmed === this.pending) return;

    this.pending = trimmed;
    this.schedule();
  }

  /** Send immediately, bypassing aggregation (milestones, warnings). */
  async milestone(text: string): Promise<void> {
    if (this.closed) return;
    this.pending = null;
    this.clearTimer();
    await this.deliver(text);
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastSentAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      const text = this.pending;
      this.pending = null;
      if (text) void this.deliver(text);
    }, wait);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async deliver(text: string): Promise<void> {
    this.lastSentAt = Date.now();
    this.lastSentText = text;
    try {
      await this.options.notifier.sendMessage(this.options.chatId, text);
    } catch {
      // A failed progress ping must never abort the task.
    }
  }

  /** Flush any pending update and stop scheduling. */
  async close(): Promise<void> {
    this.clearTimer();
    const text = this.pending;
    this.pending = null;
    this.closed = true;
    if (text) await this.deliver(text);
  }
}
