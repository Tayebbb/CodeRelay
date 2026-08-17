import { spawn, type ChildProcess } from 'node:child_process';
import { LineStream, mergeUsage, type CopilotUsage } from './events.js';
import type { CopilotLauncher } from './detect.js';
import { redact } from '../core/redact.js';
import { killProcessTree } from '../util/processTree.js';
import { buildChildEnv } from './childEnv.js';
import type { AgentEvent, AgentProvider, AgentUsage } from '../providers/types.js';

/** Translate a provider's normalised usage back into the internal totals. */
function fromAgentUsage(usage: AgentUsage): CopilotUsage {
  return {
    premiumRequests: usage.credits,
    codeChanges:
      usage.filesModified || usage.linesAdded !== undefined || usage.linesRemoved !== undefined
        ? {
            filesModified: usage.filesModified,
            linesAdded: usage.linesAdded,
            linesRemoved: usage.linesRemoved,
          }
        : undefined,
  };
}

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
  | 'startup-error'
  | 'auth-error'
  | 'model-unavailable'
  | 'quota-exhausted';

/** The Copilot-specific inputs that shape the argv. */
export interface CopilotArgsOptions {
  prompt: string;
  model: string;
  effort: string | null;
  agent: string | null;
  autopilot: boolean;
  maxAutopilotContinues: number;
  permissionArgs: string[];
  creditBudget: number;
  /** Run shell commands inside the CLI's experimental MXC sandbox. */
  sandbox?: boolean;
  /** Environment variable names whose values the CLI must strip and redact. */
  secretEnvVars?: string[];
  /** Load AGENTS.md and friends from the target repository as instructions. */
  allowRepoInstructions?: boolean;
  /** Keep the built-in GitHub MCP server enabled. */
  githubMcp?: boolean;
  /** Resume this session instead of starting cold (follow-up tasks). */
  resumeSessionId?: string | null;
}

export interface CopilotRunOptions {
  launcher: CopilotLauncher;
  /** Drives output parsing and failure classification for this session. */
  provider: AgentProvider;
  /** The argv, already built by the provider. */
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Hard ceiling on assistant turns; a runaway loop is stopped locally. */
  maxTurns: number;
  /**
   * Abort when reported usage exceeds this. The provider also passes its own
   * in-process ceiling to the CLI where one exists.
   */
  creditBudget: number;
  onProgress?: (update: ProgressUpdate) => void;
  signal?: AbortSignal;
  /** Extra environment variable names to forward to the child. */
  envPassthrough?: string[];
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
  /** False when the CLI never told us what the run cost. */
  usageReported: boolean;
  finalMessage: string;
  turns: number;
  stderr: string;
  /** Redacted transcript of notable events, for the task log. */
  transcript: string[];
}

/** Kill a process and its children (Windows needs an explicit tree kill). */
function killTree(child: ChildProcess): void {
  killProcessTree(child);
}

/** The CLI rejects `--max-ai-credits` below this. */
export const MIN_CLI_CREDIT_LIMIT = 30;

/** How long to wait for `close` after killing before abandoning the process. */
const POST_KILL_GRACE_MS = 10_000;

const QUOTA_PATTERNS = [
  /\bquota\b/i,
  /premium request/i,
  /ai credits?\b/i,
  /usage limit/i,
  /rate limit(ed)?\b/i,
  /exceeded your/i,
  /insufficient (credits?|quota|balance)/i,
];

export function looksLikeQuotaProblem(text: string): boolean {
  return QUOTA_PATTERNS.some((re) => re.test(text));
}

/** Expired or missing credentials — distinct from quota, and never retryable. */
const AUTH_PATTERNS = [
  /not (logged in|authenticated)/i,
  /authentication failed/i,
  /\bunauthorized\b/i,
  /401\b/,
  /copilot login/i,
  /no account is signed in/i,
  /token (has )?expired/i,
  /personal access tokens?.*not supported/i,
];

export function looksLikeAuthProblem(text: string): boolean {
  return AUTH_PATTERNS.some((re) => re.test(text));
}

/**
 * The CLI advertises a model in its catalogue but can still refuse it at run
 * time once that model's entitlement is used up. Observed live:
 *   Error: Model "claude-opus-5" from --model flag is not available.
 * This is recoverable — another model usually still works — so it must not be
 * lumped in with fatal startup errors.
 */
const MODEL_PATTERNS = [
  /from --model flag is not available/i,
  /model\s+"?[\w.\-]+"?\s+is not available/i,
  /unknown model/i,
  /model .* (is )?(not supported|unsupported)/i,
];

function looksLikeModelProblemInternal(text: string): boolean {
  return MODEL_PATTERNS.some((re) => re.test(text));
}

/** Exported so the provider layer classifies failures with the same patterns. */
export const looksLikeModelProblem = looksLikeModelProblemInternal;

/**
 * The subset of the run options that shapes the argv. Kept separate so the
 * provider layer can build arguments without inventing a launcher, a working
 * directory or timeouts it has no business supplying.
 */

/** Assemble the argv for a non-interactive Copilot run. */
export function buildCopilotArgs(options: CopilotArgsOptions): string[] {
  const args: string[] = ['-p', options.prompt, '--output-format', 'json', '--no-color'];

  args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  if (options.agent) args.push('--agent', options.agent);

  // Warm-start a previous session (follow-up tasks). Must be the explicit
  // `--resume=<id>` form: a bare `--resume` wants a TTY picker under -p.
  if (options.resumeSessionId) args.push(`--resume=${options.resumeSessionId}`);

  // A real in-process ceiling: the CLI blocks the next model call once this is
  // reached. It refuses values below its documented minimum, so smaller budgets
  // stay enforced by this application alone.
  if (options.creditBudget >= MIN_CLI_CREDIT_LIMIT) {
    args.push('--max-ai-credits', String(Math.floor(options.creditBudget)));
  }

  if (options.sandbox) args.push('--experimental', '--sandbox');

  if (options.autopilot) {
    args.push('--mode', 'autopilot', '--max-autopilot-continues', String(options.maxAutopilotContinues));
  }

  // Unattended: never wait for a human at the terminal, never let the session be
  // driven from elsewhere, never auto-update mid-task.
  args.push('--no-ask-user', '--no-remote', '--no-auto-update');

  // The working directory is the TARGET repository, and the CLI loads AGENTS.md
  // / CLAUDE.md / copilot-instructions.md from it as INSTRUCTIONS. That is
  // indirect prompt injection by design, so it is off unless opted in.
  if (!options.allowRepoInstructions) args.push('--no-custom-instructions');

  // The built-in GitHub MCP server speaks HTTP directly with the operator's
  // GitHub identity, so it is NOT covered by --allow-url/--deny-url. Left on it
  // is an exfiltration channel (gists, issues, private repos).
  if (!options.githubMcp) args.push('--disable-builtin-mcps');

  for (const name of options.secretEnvVars ?? []) {
    args.push(`--secret-env-vars=${name}`);
  }

  args.push(...options.permissionArgs);
  return args;
}

/** Run one non-interactive agent session and stream aggregated progress. */
export function runCopilot(options: CopilotRunOptions): Promise<CopilotRunResult> {
  return new Promise((resolve) => {
    const provider = options.provider;
    const args = options.args;
    const transcript: string[] = [];
    const stream = new LineStream();

    let stderr = '';
    let sessionId: string | null = null;
    let usage: CopilotUsage = {};
    let outputTokens = 0;
    let turns = 0;
    let finalMessage = '';
    let stopReason: StopReason = 'completed';
    let settled = false;
    let sawTerminalEvent = false;
    let killWatchdog: NodeJS.Timeout | null = null;
    // A quota-looking line in stderr is only a hint: tools legitimately print
    // "rate limit" while succeeding. It is confirmed against the exit code.
    let quotaHint = false;

    const progress = (kind: ProgressKind, text: string) => {
      const safe = redact(text);
      transcript.push(`[${kind}] ${safe}`);
      if (transcript.length > 500) transcript.splice(0, transcript.length - 500);
      options.onProgress?.({ kind, text: safe });
    };

    // Built from an allow-list: the operator's shell may hold credentials that
    // an unattended agent working on untrusted code must never see.
    const childEnv = buildChildEnv(process.env, { passthrough: options.envPassthrough });

    let child: ChildProcess;
    try {
      child = spawn(options.launcher.command, [...options.launcher.baseArgs, ...args], {
        cwd: options.cwd,
        env: childEnv,
        shell: false,
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
        usageReported: false,
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
      progress('limit', `Stopping ${provider.displayName}: ${reason}`);
      killTree(child);
      // `close` only fires once every inherited stdio pipe is closed. A
      // surviving grandchild holding stdout would otherwise hang this promise —
      // and with it the task, its queue slot, and the whole project — forever.
      if (killWatchdog) return;
      killWatchdog = setTimeout(() => finish(null, true), POST_KILL_GRACE_MS);
      killWatchdog.unref?.();
    };

    const timer = setTimeout(() => stopWith('timeout'), options.timeoutMs);
    const onAbort = () => stopWith('cancelled');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const handleEvent = (event: AgentEvent) => {
      switch (event.kind) {
        case 'session':
          if (event.text) progress('session', event.text);
          break;

        case 'turn-start':
          turns += 1;
          if (turns > options.maxTurns) stopWith('turn-limit');
          break;

        case 'thinking':
          if (event.text) progress('thinking', event.text);
          break;

        case 'message':
          if (event.text.trim()) {
            finalMessage = event.text;
            progress('message', event.text.slice(0, 1200));
          }
          break;

        case 'tool':
          if (event.text) progress('tool', event.text);
          break;

        case 'warning':
          if (event.text) progress('warning', event.text);
          break;

        default:
          break;
      }

      if (typeof event.outputTokens === 'number') outputTokens += event.outputTokens;
      if (event.sessionId) sessionId = event.sessionId;
      if (event.usage) usage = mergeUsage(usage, fromAgentUsage(event.usage));
      if (event.terminal) sawTerminalEvent = true;

      const credits = usage.premiumRequests ?? 0;
      if (options.creditBudget > 0 && credits > options.creditBudget) {
        stopWith('credit-limit');
      }
    };

    child.stdout?.setEncoding('utf8');
    // Without an 'error' listener a pipe error after a forced kill throws and
    // takes the agent down, orphaning this very process while it still spends.
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    child.stdout?.on('data', (chunk: string) => {
      // One malformed line from the CLI must degrade this task only, never
      // escape as an uncaught exception and restart the whole agent.
      try {
        for (const line of stream.push(chunk)) {
          for (const event of provider.parseLine(line)) handleEvent(event);
        }
      } catch (err) {
        stderr = (stderr + `\n[remote-agent] could not parse CLI output: ${String(err)}`).slice(-20_000);
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-20_000);
      if (looksLikeQuotaProblem(chunk) || provider.looksLikeQuota(chunk)) {
        quotaHint = true;
        progress('warning', `${provider.displayName} mentioned a usage/quota condition.`);
      }
    });

    const finish = (exitCode: number | null, abandoned = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killWatchdog) clearTimeout(killWatchdog);
      options.signal?.removeEventListener('abort', onAbort);
      try {
        for (const line of stream.flush()) {
          for (const event of provider.parseLine(line)) handleEvent(event);
        }
      } catch {
        // A trailing partial line is not worth failing over.
      }

      if (abandoned) {
        stderr = (
          stderr +
          `\n[remote-agent] ${provider.displayName} was killed but did not report exit; abandoning the process.`
        ).slice(-20_000);
      }

      const credits = usage.premiumRequests ?? 0;
      if (stopReason === 'completed' && exitCode !== 0) {
        const diagnostics = stderr + finalMessage;
        // Credentials first: an auth failure is neither a quota problem nor a
        // transient startup error, and retrying it only wastes time.
        const classified = provider.classifyFailure(diagnostics);
        if (classified) {
          stopReason = classified;
        } else if (quotaHint) {
          stopReason = 'quota-exhausted';
        } else if (!sawTerminalEvent && turns === 0) {
          // Died during argument parsing / model resolution: no JSON at all.
          stopReason = 'startup-error';
        }
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
        usageReported: sawTerminalEvent && usage.premiumRequests !== undefined,
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
