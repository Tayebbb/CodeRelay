/**
 * Claude Code provider.
 *
 * Every flag here was verified against the installed CLI (2.1.92) with
 * `claude --help`, not assumed. The mapping to this application's safety model:
 *
 *   Copilot                          Claude Code
 *   --deny-tool=shell(curl)      ->  --disallowedTools "Bash(curl:*)"
 *   --deny-tool=write(.env)      ->  --disallowedTools "Edit Write"   (tool-level only)
 *   --no-custom-instructions     ->  --bare  (also skips hooks, plugins, CLAUDE.md)
 *   --disable-builtin-mcps       ->  --strict-mcp-config
 *   --max-ai-credits             ->  --max-budget-usd
 *   --output-format json         ->  --output-format stream-json
 *
 * Two honest gaps, declared in `capabilities` rather than papered over:
 *   - there is no per-domain URL allow-list; WebFetch can only be denied wholesale
 *   - write denial is per-TOOL, not per-PATH, so a single sensitive file cannot
 *     be protected while others stay writable
 */

import os from 'node:os';
import path from 'node:path';
import { execCommand } from '../util/exec.js';
import { resolveOnPath } from '../util/which.js';
import { DEFAULT_DENIED_COMMANDS, DEFAULT_DENIED_GIT_SUBCOMMANDS } from '../copilot/permissions.js';
import type {
  AgentEvent,
  AgentProvider,
  BuildArgsInput,
  FailureKind,
  ProviderInfo,
  ProviderLauncher,
} from './types.js';

/** Tools that create or modify files; denied wholesale for read-only roles. */
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

/** Reaches the network outside the shell, and cannot be limited by domain. */
const NETWORK_TOOLS = ['WebFetch', 'WebSearch'];

function launcherFor(binOverride: string | null): ProviderLauncher | null {
  const resolved = binOverride ?? resolveOnPath('claude');
  if (!resolved) return null;

  // A .ps1/.cmd shim would need a shell, which we refuse to use for untrusted
  // argument values. The native executable is required.
  if (/\.(ps1|cmd|bat)$/i.test(resolved)) {
    return { command: resolved, baseArgs: [], description: resolved, safe: false };
  }
  return { command: resolved, baseArgs: [], description: path.basename(resolved), safe: true };
}

export const claudeProvider: AgentProvider = {
  id: 'claude',
  displayName: 'Claude Code',
  billing: 'your Anthropic plan or API credits (NOT included with GitHub Copilot)',

  capabilities: {
    denyShellCommands: true, // --disallowedTools "Bash(cmd:*)"
    denyFileWrites: true, // --disallowedTools "Edit Write NotebookEdit"
    allowUrlsByDomain: false, // WebFetch is all-or-nothing
    reportsUsage: true, // stream-json result event carries total_cost_usd
    ignoreRepoInstructions: true, // --bare skips CLAUDE.md auto-discovery and hooks
    ignoreRepoMcp: true, // --strict-mcp-config
    nativeBudgetCeiling: true, // --max-budget-usd
    sandbox: false,
    // We pass --no-session-persistence (sessions are never written to disk), so
    // there is nothing to resume. Enabling this would first need a live-verified
    // run WITH persistence and a decision about where session state lands.
    resumeSessions: false,
  },

  async detect(binOverride: string | null): Promise<ProviderInfo> {
    const launcher = launcherFor(binOverride);
    if (!launcher) {
      return {
        id: 'claude',
        installed: false,
        version: null,
        launcher: null,
        models: [],
        authenticatedUser: null,
        error: 'Claude Code not found. Install it from https://claude.com/product/claude-code',
      };
    }

    // Probed from a neutral directory: detection must never execute with the
    // target repository as the working directory.
    const version = await execCommand(launcher.command, [...launcher.baseArgs, '--version'], {
      cwd: os.tmpdir(),
      timeoutMs: 20_000,
      shell: false,
    });

    return {
      id: 'claude',
      installed: version.code === 0,
      version: version.code === 0 ? version.stdout.trim().split('\n')[0]?.trim() ?? null : null,
      launcher,
      // Claude Code takes aliases rather than publishing a catalogue.
      models: ['opus', 'sonnet', 'haiku'],
      // The CLI has no non-interactive "who am I"; auth failures surface at run time.
      authenticatedUser: version.code === 0 ? 'configured' : null,
      error: version.code === 0 ? null : version.stderr.trim() || 'claude --version failed',
    };
  },

  buildArgs(input: BuildArgsInput): string[] {
    const args: string[] = ['-p', input.prompt, '--output-format', 'stream-json', '--verbose'];

    args.push('--model', input.model);

    // Skips hooks, plugin sync and CLAUDE.md auto-discovery — the repository-
    // supplied instruction channels this application treats as injection.
    if (!input.allowRepoInstructions) args.push('--bare');
    if (!input.allowRepoMcp) args.push('--strict-mcp-config');

    // Never resume or write session state into the target repository.
    args.push('--no-session-persistence');

    if (input.budget > 0) args.push('--max-budget-usd', input.budget.toFixed(2));

    for (const dir of input.extraDirs) args.push('--add-dir', dir);

    // acceptEdits, never bypassPermissions: the deny list below must still bind.
    args.push('--permission-mode', 'acceptEdits');

    // The deny-list is shared with the Copilot provider so the two cannot drift
    // apart: a command added for one is denied by both.
    const denied = [
      ...DEFAULT_DENIED_COMMANDS.map((c) => `Bash(${c}:*)`),
      ...DEFAULT_DENIED_GIT_SUBCOMMANDS.map((s) => `Bash(git ${s}:*)`),
      ...input.extraDeniedCommands.map((c) => `Bash(${c}:*)`),
      ...NETWORK_TOOLS,
      ...(input.readOnly ? WRITE_TOOLS : []),
    ];
    args.push('--disallowedTools', denied.join(' '));

    return args;
  },

  parseLine(line: string): AgentEvent[] {
    const trimmed = line.trim();
    // `JSON.parse("null")` and `JSON.parse("[]")` both succeed, so parsing alone
    // is not enough: the result must be verified to be an object before use.
    if (!trimmed.startsWith('{')) return [];

    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
      event = parsed as Record<string, unknown>;
    } catch {
      return [];
    }

    const type = typeof event.type === 'string' ? event.type : '';
    const sessionId = typeof event.session_id === 'string' ? event.session_id : null;

    if (type === 'result') {
      const cost = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined;
      return [
        {
          kind: 'usage',
          text: typeof event.result === 'string' ? event.result : '',
          sessionId,
          terminal: true,
          usage: { credits: cost },
        },
      ];
    }

    if (type === 'assistant' || type === 'user') {
      const message = event.message as { content?: unknown } | undefined;
      const content = Array.isArray(message?.content) ? message?.content : [];
      const out: AgentEvent[] = [];
      // Claude Code emits one assistant message per turn.
      if (type === 'assistant') out.push({ kind: 'turn-start', text: '', sessionId });
      for (const part of content) {
        const block = part as { type?: string; name?: string; text?: string; thinking?: string };
        if (block.type === 'tool_use' && block.name) out.push({ kind: 'tool', text: block.name, sessionId });
        else if (block.type === 'thinking') out.push({ kind: 'thinking', text: (block.thinking ?? '').slice(0, 400) });
        else if (block.type === 'text' && block.text) out.push({ kind: 'message', text: block.text, sessionId });
      }
      return out;
    }

    if (type === 'system') {
      const model = typeof event.model === 'string' ? event.model : null;
      return model ? [{ kind: 'session', text: `Model: ${model}`, sessionId }] : [];
    }

    return [];
  },

  classifyFailure(diagnostics: string): FailureKind | null {
    if (/invalid api key|authentication|unauthorized|please run.*login|not logged in/i.test(diagnostics)) {
      return 'auth-error';
    }
    if (/model.*(not found|not available|unknown)/i.test(diagnostics)) return 'model-unavailable';
    if (/credit balance|billing|quota|usage limit|rate limit/i.test(diagnostics)) return 'quota-exhausted';
    return null;
  },

  looksLikeQuota(text: string): boolean {
    return /credit balance|usage limit|rate limit|quota/i.test(text);
  },
};
