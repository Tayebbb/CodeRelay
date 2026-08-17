/**
 * GitHub Copilot CLI as a provider.
 *
 * This deliberately DELEGATES to `src/copilot/`, which is the implementation
 * that has been through live acceptance and red-teaming. Re-expressing those
 * flags here would risk losing a protection in translation, so this file only
 * adapts shapes.
 */

import { detectCopilot } from '../copilot/detect.js';
import {
  buildCopilotArgs,
  looksLikeAuthProblem,
  looksLikeModelProblem,
  looksLikeQuotaProblem,
} from '../copilot/executor.js';
import { buildPermissionPolicy } from '../copilot/permissions.js';
import { normaliseShutdownUsage, parseJsonlLine, toolRequestName, type CopilotUsage } from '../copilot/events.js';
import type {
  AgentEvent,
  AgentProvider,
  AgentUsage,
  BuildArgsInput,
  FailureKind,
  ProviderInfo,
} from './types.js';

function toAgentUsage(usage: CopilotUsage | undefined): AgentUsage {
  return {
    credits: usage?.premiumRequests,
    filesModified: usage?.codeChanges?.filesModified,
    linesAdded: usage?.codeChanges?.linesAdded,
    linesRemoved: usage?.codeChanges?.linesRemoved,
  };
}

export const copilotProvider: AgentProvider = {
  id: 'copilot',
  displayName: 'GitHub Copilot CLI',
  billing: 'your existing GitHub Copilot subscription (no additional cost)',

  capabilities: {
    denyShellCommands: true, // --deny-tool=shell(x)
    denyFileWrites: true, // --deny-tool=write(path) — per PATH, not just per tool
    allowUrlsByDomain: true, // --allow-url / --deny-url
    reportsUsage: true, // JSON events carry credit usage
    ignoreRepoInstructions: true, // --no-custom-instructions
    ignoreRepoMcp: true, // --disable-builtin-mcps
    nativeBudgetCeiling: true, // --max-ai-credits
    sandbox: true, // --sandbox --experimental
    resumeSessions: true, // --resume=<session-id>, verified on 1.0.80 with -p
  },

  async detect(binOverride: string | null): Promise<ProviderInfo> {
    const info = await detectCopilot(binOverride ?? undefined);
    return {
      id: 'copilot',
      installed: info.installed,
      version: info.version,
      launcher: info.launcher,
      models: info.models,
      authenticatedUser: info.authenticatedUser,
      error: info.error ?? null,
    };
  },

  buildArgs(input: BuildArgsInput): string[] {
    const policy = buildPermissionPolicy({
      allowedUrls: input.allowedUrls,
      extraDeniedCommands: input.extraDeniedCommands,
      extraDirs: input.extraDirs,
    });

    // A bare `--deny-tool=write` denies every write tool, which is how the
    // advisory roles are held read-only at the tool level rather than by asking.
    const permissionArgs = input.readOnly ? [...policy.args, '--deny-tool=write'] : policy.args;

    return buildCopilotArgs({
      prompt: input.prompt,
      model: input.model,
      effort: input.effort,
      agent: input.agent,
      creditBudget: input.budget,
      sandbox: input.sandbox,
      autopilot: input.autopilot,
      maxAutopilotContinues: input.maxAutopilotContinues,
      allowRepoInstructions: input.allowRepoInstructions,
      githubMcp: input.allowRepoMcp,
      secretEnvVars: input.secretEnvVars,
      resumeSessionId: input.resumeSessionId ?? null,
      permissionArgs,
    });
  },

  /**
   * A faithful translation of the Copilot envelope stream. `session.shutdown`
   * is kept as a second usage source so a schema change in `result` cannot
   * silently report a paid run as free.
   */
  parseLine(line: string): AgentEvent[] {
    const envelope = parseJsonlLine(line);
    if (!envelope) return [];

    const data = (envelope.data ?? {}) as Record<string, unknown>;
    const sessionId = envelope.sessionId ?? null;
    const out: AgentEvent[] = [];

    switch (envelope.type) {
      case 'session.tools_updated':
        if (typeof data.model === 'string') out.push({ kind: 'session', text: `Model: ${data.model}` });
        break;

      case 'session.model_change':
        if (typeof data.newModel === 'string') out.push({ kind: 'session', text: `Model: ${data.newModel}` });
        break;

      case 'assistant.turn_start':
        out.push({ kind: 'turn-start', text: '' });
        break;

      case 'assistant.reasoning': {
        const content = typeof data.content === 'string' ? data.content : '';
        if (content) out.push({ kind: 'thinking', text: content.slice(0, 400) });
        break;
      }

      case 'assistant.message': {
        const content = typeof data.content === 'string' ? data.content : '';
        if (content.trim()) out.push({ kind: 'message', text: content });
        if (typeof data.outputTokens === 'number') {
          out.push({ kind: 'other', text: '', outputTokens: data.outputTokens });
        }
        for (const request of Array.isArray(data.toolRequests) ? data.toolRequests : []) {
          const name = toolRequestName(request);
          if (name) out.push({ kind: 'tool', text: name });
        }
        break;
      }

      case 'result':
        out.push({
          kind: 'usage',
          text: '',
          sessionId,
          terminal: true,
          usage: toAgentUsage(envelope.usage),
        });
        break;

      case 'session.shutdown':
        out.push({
          kind: 'usage',
          text: '',
          sessionId,
          terminal: true,
          usage: toAgentUsage(normaliseShutdownUsage(data)),
        });
        break;

      default:
        if (envelope.type.startsWith('tool.') || envelope.type.startsWith('session.tool')) {
          const name =
            (typeof data.name === 'string' && data.name) ||
            (typeof data.toolName === 'string' && data.toolName) ||
            envelope.type;
          out.push({ kind: 'tool', text: name });
        }
        break;
    }

    return out;
  },

  classifyFailure(diagnostics: string): FailureKind | null {
    if (looksLikeAuthProblem(diagnostics)) return 'auth-error';
    if (looksLikeModelProblem(diagnostics)) return 'model-unavailable';
    if (looksLikeQuotaProblem(diagnostics)) return 'quota-exhausted';
    return null;
  },

  looksLikeQuota(text: string): boolean {
    return looksLikeQuotaProblem(text);
  },
};
