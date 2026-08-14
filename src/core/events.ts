/**
 * The one event stream every interface observes.
 *
 * Telegram and the web UI must never disagree about what happened, so neither
 * gets a private feed: the repository and runner publish here, and every
 * connected client — a Telegram chat, an SSE stream, a future UI — sees the
 * same sequence. Events carry only already-redacted text.
 */

export type AgentEventKind =
  | 'task-created'
  | 'task-status'
  | 'task-log'
  | 'task-progress'
  | 'approval-requested'
  | 'approval-resolved';

export interface BusEvent {
  /** Monotonic id, so a reconnecting client can ask for what it missed. */
  seq: number;
  ts: number;
  kind: AgentEventKind;
  taskId: number;
  /** Small, JSON-safe payload. Never raw CLI output, never secrets. */
  data: Record<string, string | number | boolean | null>;
}

export type BusListener = (event: BusEvent) => void;

const REPLAY_BUFFER = 500;

export class EventBus {
  private listeners = new Set<BusListener>();
  private buffer: BusEvent[] = [];
  private seq = 0;

  publish(kind: AgentEventKind, taskId: number, data: BusEvent['data'] = {}): void {
    const event: BusEvent = { seq: ++this.seq, ts: Date.now(), kind, taskId, data };
    this.buffer.push(event);
    if (this.buffer.length > REPLAY_BUFFER) this.buffer.splice(0, this.buffer.length - REPLAY_BUFFER);

    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // One broken client must not sever the stream for the others.
      }
    }
  }

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Events after `afterSeq`, for SSE reconnection via Last-Event-ID. */
  since(afterSeq: number): BusEvent[] {
    return this.buffer.filter((e) => e.seq > afterSeq);
  }
}
