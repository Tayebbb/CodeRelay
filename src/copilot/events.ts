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
