/**
 * Event shapes emitted by `copilot --output-format json` (JSONL, one object per
 * line). Verified against Copilot CLI 1.0.63. Everything is optional-tolerant:
 * a future CLI version may add or rename fields and the runner must not crash.
 */

export interface CopilotEnvelope {
  type: string;
  id?: string;
  timestamp?: string;
  parentId?: string;
  ephemeral?: boolean;
  data?: Record<string, unknown>;
  // The terminal `result` event puts its fields at the top level.
  sessionId?: string;
  exitCode?: number;
  usage?: CopilotUsage;
}

export interface CopilotUsage {
  premiumRequests?: number;
  totalApiDurationMs?: number;
  sessionDurationMs?: number;
  codeChanges?: {
    linesAdded?: number;
    linesRemoved?: number;
    filesModified?: string[];
  };
}

/**
 * `session.shutdown` reports the same totals as `result` under different names
 * (`totalPremiumRequests`, and `totalNanoAiu` on AI-credit billing). Reading it
 * as a fallback means a CLI schema change cannot silently report a run as free.
 */
export function normaliseShutdownUsage(data: Record<string, unknown>): CopilotUsage {
  const usage: CopilotUsage = {};

  const premium = data.totalPremiumRequests ?? data.premiumRequests;
  if (typeof premium === 'number' && premium > 0) {
    usage.premiumRequests = premium;
  } else if (typeof data.totalNanoAiu === 'number' && data.totalNanoAiu > 0) {
    usage.premiumRequests = data.totalNanoAiu / 1e9;
  } else if (typeof premium === 'number') {
    usage.premiumRequests = premium;
  }

  if (typeof data.totalApiDurationMs === 'number') usage.totalApiDurationMs = data.totalApiDurationMs;

  const changes = data.codeChanges as CopilotUsage['codeChanges'] | undefined;
  if (changes && typeof changes === 'object') usage.codeChanges = changes;

  return usage;
}

/** Combine usage reports, preferring the larger/more complete figures. */
export function mergeUsage(base: CopilotUsage, incoming: CopilotUsage | undefined): CopilotUsage {
  if (!incoming) return base;
  const merged: CopilotUsage = { ...base };

  if (incoming.premiumRequests !== undefined) {
    merged.premiumRequests = Math.max(base.premiumRequests ?? 0, incoming.premiumRequests);
  }
  if (incoming.totalApiDurationMs !== undefined) merged.totalApiDurationMs = incoming.totalApiDurationMs;
  if (incoming.sessionDurationMs !== undefined) merged.sessionDurationMs = incoming.sessionDurationMs;

  if (incoming.codeChanges) {
    const files = new Set([
      ...(base.codeChanges?.filesModified ?? []),
      ...(incoming.codeChanges.filesModified ?? []),
    ]);
    merged.codeChanges = {
      linesAdded: Math.max(base.codeChanges?.linesAdded ?? 0, incoming.codeChanges.linesAdded ?? 0),
      linesRemoved: Math.max(base.codeChanges?.linesRemoved ?? 0, incoming.codeChanges.linesRemoved ?? 0),
      filesModified: [...files],
    };
  }
  return merged;
}

export interface ToolRequest {
  name?: string;
  toolName?: string;
  arguments?: unknown;
}

/** Best-effort tool name extraction across CLI shapes. */
export function toolRequestName(request: unknown): string | null {
  if (!request || typeof request !== 'object') return null;
  const r = request as ToolRequest & Record<string, unknown>;
  const name = r.name ?? r.toolName ?? (r['tool'] as string | undefined);
  return typeof name === 'string' ? name : null;
}

export function parseJsonlLine(line: string): CopilotEnvelope | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as CopilotEnvelope;
    return typeof parsed?.type === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Incremental line reader for a streaming stdout. Provider-agnostic: splitting
 * on newlines is common to every agent CLI, while interpreting a line is not.
 */
export class LineStream {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    let index: number;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      out.push(this.buffer.slice(0, index));
      this.buffer = this.buffer.slice(index + 1);
    }
    // A single pathological line must not grow without bound.
    if (this.buffer.length > 4_000_000) this.buffer = this.buffer.slice(-1_000_000);
    return out;
  }

  flush(): string[] {
    const rest = this.buffer;
    this.buffer = '';
    return rest.trim() ? [rest] : [];
  }
}

/** Incremental newline-delimited JSON reader for a streaming stdout. */
export class JsonlStream {
  private buffer = '';

  push(chunk: string): CopilotEnvelope[] {
    this.buffer += chunk;
    const out: CopilotEnvelope[] = [];
    let index: number;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      const event = parseJsonlLine(line);
      if (event) out.push(event);
    }
    // A single pathological line must not grow without bound.
    if (this.buffer.length > 4_000_000) this.buffer = this.buffer.slice(-1_000_000);
    return out;
  }

  flush(): CopilotEnvelope[] {
    const rest = this.buffer;
    this.buffer = '';
    const event = parseJsonlLine(rest);
    return event ? [event] : [];
  }
}
