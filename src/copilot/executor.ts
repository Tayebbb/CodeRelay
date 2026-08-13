import { spawn, type ChildProcess } from 'node:child_process';
import { JsonlStream, toolRequestName, type CopilotEnvelope, type CopilotUsage } from './events.js';
import type { CopilotLauncher } from './detect.js';
import { redact } from '../core/redact.js';

export type ProgressKind =
  | 'session'
  | 'thinking'
  | 'message'
  | 'tool'
  | 'turn'
  | 'warning'
  | 'limit';

export interface ProgressUpdate {
  kind: ProgressKind;
  text: string;
}

export type StopReason =
  | 'completed'
  | 'timeout'
  | 'cancelled'
  | 'turn-limit'
  | 'credit-limit'
  | 'spawn-error'
  | 'quota-exhausted';

export interface CopilotRunOptions {
  launcher: CopilotLauncher;
  cwd: string;
  prompt: string;
  model: string;
  effort: string | null;
  agent: string | null;
  autopilot: boolean;
  maxAutopilotContinues: number;
  permissionArgs: string[];
  timeoutMs: number;
  /** Hard ceiling on assistant turns; a runaway loop is stopped locally. */
  maxTurns: number;
  /**
   * Abort as soon as reported AI credits exceed this. The CLI reports usage only
   * in the terminal `result` event, so this is primarily a post-hoc guard —
   * see README "Cost protection" for the exact semantics.
   */
  creditBudget: number;
  onProgress?: (update: ProgressUpdate) => void;
  signal?: AbortSignal;
  /** Environment variable names whose values the CLI must strip and redact. */
  secretEnvVars?: string[];
}

export interface CopilotRunResult {
  exitCode: number | null;
  stopReason: StopReason;
  sessionId: string | null;
  usage: CopilotUsage;
  aiCredits: number;
  outputTokens: number;
  filesModified: string[];
  linesAdded: number;
  linesRemoved: number;
  finalMessage: string;
  turns: number;
  stderr: string;
  /** Redacted transcript of notable events, for the task log. */
  transcript: string[];
}

/** Kill a process and its children (Windows needs an explicit tree kill). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch {
      // fall through to the generic kill
    }
  }
  try {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 5_000).unref();
  } catch {
    // already gone
  }
}

const QUOTA_PATTERNS = [
  /quota/i,
  /premium request/i,
  /ai credit/i,
  /rate limit/i,
  /usage limit/i,
  /exceeded your/i,
  /insufficient/i,
];

function looksLikeQuotaProblem(text: string): boolean {
  return QUOTA_PATTERNS.some((re) => re.test(text));
}

/** Assemble the argv for a non-interactive Copilot run. */
export function buildCopilotArgs(options: CopilotRunOptions): string[] {
  const args: string[] = ['-p', options.prompt, '--output-format', 'json', '--no-color'];

  args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  if (options.agent) args.push('--agent', options.agent);

  if (options.autopilot) {
    args.push('--mode', 'autopilot', '--max-autopilot-continues', String(options.maxAutopilotContinues));
  }

  // Unattended: never wait for a human at the terminal, never let the session be
  // driven from elsewhere, never auto-update mid-task, no memory bleed between tasks.
  args.push('--no-ask-user', '--no-remote', '--no-auto-update');

  for (const name of options.secretEnvVars ?? []) {
    args.push(`--secret-env-vars=${name}`);
  }

  args.push(...options.permissionArgs);
  return args;
}

/** Run one non-interactive Copilot session and stream aggregated progress. */
export function runCopilot(options: CopilotRunOptions): Promise<CopilotRunResult> {
  return new Promise((resolve) => {
    const args = buildCopilotArgs(options);
    const transcript: string[] = [];
    const stream = new JsonlStream();

    let stderr = '';
    let sessionId: string | null = null;
    let usage: CopilotUsage = {};
    let outputTokens = 0;
    let turns = 0;
    let finalMessage = '';
    let stopReason: StopReason = 'completed';
    let settled = false;

    const progress = (kind: ProgressKind, text: string) => {
      const safe = redact(text);
      transcript.push(`[${kind}] ${safe}`);
      if (transcript.length > 500) transcript.splice(0, transcript.length - 500);
      options.onProgress?.({ kind, text: safe });
    };

    // The child inherits a sanitised environment: nothing from this app's own
    // secrets is forwarded.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', CI: '1' };
    delete childEnv.TELEGRAM_BOT_TOKEN;
    delete childEnv.AUTHORIZED_TELEGRAM_USER_ID;

    let child: ChildProcess;
    try {
      child = spawn(options.launcher.command, [...options.launcher.baseArgs, ...args], {
        cwd: options.cwd,
        env: childEnv,
        shell: !options.launcher.safe,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        exitCode: null,
        stopReason: 'spawn-error',
        sessionId: null,
        usage: {},
        aiCredits: 0,
        outputTokens: 0,
        filesModified: [],
        linesAdded: 0,
        linesRemoved: 0,
        finalMessage: '',
        turns: 0,
        stderr: redact(String(err)),
        transcript,
      });
      return;
    }

    const stopWith = (reason: StopReason) => {
      if (settled) return;
      stopReason = reason;
      progress('limit', `Stopping Copilot: ${reason}`);
      killTree(child);
    };

    const timer = setTimeout(() => stopWith('timeout'), options.timeoutMs);
    const onAbort = () => stopWith('cancelled');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const handleEvent = (event: CopilotEnvelope) => {
      const data = (event.data ?? {}) as Record<string, unknown>;

      switch (event.type) {
        case 'session.tools_updated':
          if (typeof data.model === 'string') progress('session', `Model: ${data.model}`);
          break;

        case 'assistant.turn_start':
          turns += 1;
          if (turns > options.maxTurns) stopWith('turn-limit');
          break;

        case 'assistant.reasoning': {
          const content = typeof data.content === 'string' ? data.content : '';
          if (content) progress('thinking', content.slice(0, 400));
          break;
        }

        case 'assistant.message': {
          const content = typeof data.content === 'string' ? data.content : '';
          if (content.trim()) {
            finalMessage = content;
            progress('message', content.slice(0, 1200));
          }
          if (typeof data.outputTokens === 'number') outputTokens += data.outputTokens;

          const requests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
          for (const request of requests) {
            const name = toolRequestName(request);
            if (name) progress('tool', name);
          }
          break;
        }

        case 'result': {
          sessionId = event.sessionId ?? null;
          usage = event.usage ?? {};
          break;
        }

        default: {
          if (event.type.startsWith('tool.') || event.type.startsWith('session.tool')) {
            const name =
              (typeof data.name === 'string' && data.name) ||
              (typeof data.toolName === 'string' && data.toolName) ||
              event.type;
            progress('tool', name);
          }
          break;
        }
      }

      const credits = usage.premiumRequests ?? 0;
      if (options.creditBudget > 0 && credits > options.creditBudget) {
        stopWith('credit-limit');
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      for (const event of stream.push(chunk)) handleEvent(event);
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-20_000);
      if (looksLikeQuotaProblem(chunk)) {
        progress('warning', 'Copilot reported a usage/quota condition.');
        stopReason = 'quota-exhausted';
      }
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      for (const event of stream.flush()) handleEvent(event);

      const credits = usage.premiumRequests ?? 0;
      if (stopReason === 'completed' && exitCode !== 0 && looksLikeQuotaProblem(stderr + finalMessage)) {
        stopReason = 'quota-exhausted';
      }

      resolve({
        exitCode,
        stopReason,
        sessionId,
        usage,
        aiCredits: credits,
        outputTokens,
        filesModified: usage.codeChanges?.filesModified ?? [],
        linesAdded: usage.codeChanges?.linesAdded ?? 0,
        linesRemoved: usage.codeChanges?.linesRemoved ?? 0,
        finalMessage: redact(finalMessage),
        turns,
        stderr: redact(stderr),
        transcript,
      });
    };

    child.on('error', (err) => {
      stderr = redact(stderr + '\n' + String(err));
      if (stopReason === 'completed') stopReason = 'spawn-error';
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
