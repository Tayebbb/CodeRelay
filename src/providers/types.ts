/**
 * Support for more than one agent CLI.
 *
 * The safety machinery in this application — checkpoints, filter-driver
 * detection, repository scanning, approvals, verification, redaction, budgets —
 * does not care which AI produced the diff. What IS provider-specific is the
 * narrow layer that launches a CLI and reads its events.
 *
 * The danger in making that pluggable is silent downgrade: the deny-list is
 * currently written in Copilot's flag language, and a CLI that cannot express
 * "deny shell(curl)" would quietly void a protection the documentation still
 * promises. So every provider must DECLARE its capabilities, and the runner
 * refuses to start when a required one is missing. Absent capabilities fail
 * closed; they are never assumed.
 */

export type ProviderId = 'copilot' | 'claude';

/**
 * Kept free of any dependency on the concrete providers so that configuration
 * can validate a name without importing the CLI detection code.
 */
export const PROVIDER_IDS: ProviderId[] = ['copilot', 'claude'];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as string[]).includes(value);
}

/**
 * What a provider can actually enforce. Each flag must correspond to a real,
 * verified flag on the installed CLI — never to a hoped-for one.
 */
export interface ProviderCapabilities {
  /** Can refuse named shell commands (the interpreter/exfiltration deny-list). */
  denyShellCommands: boolean;
  /** Can refuse file-writing tools, used for the read-only advisory roles. */
  denyFileWrites: boolean;
  /** Can restrict network access per-domain, not merely per-tool. */
  allowUrlsByDomain: boolean;
  /** Reports what a run cost, so credit budgets can be enforced between runs. */
  reportsUsage: boolean;
  /** Can be told to ignore instruction files found in the target repository. */
  ignoreRepoInstructions: boolean;
  /** Can be told to ignore MCP servers configured by the target repository. */
  ignoreRepoMcp: boolean;
  /** Has a built-in spend ceiling of its own, independent of ours. */
  nativeBudgetCeiling: boolean;
  /** Runs shell commands inside a sandbox rather than as the full user. */
  sandbox: boolean;
}

/** Capabilities this application treats as mandatory. */
export const REQUIRED_CAPABILITIES: Array<keyof ProviderCapabilities> = [
  'denyShellCommands',
  'denyFileWrites',
  'ignoreRepoInstructions',
  'ignoreRepoMcp',
];

export interface ProviderLauncher {
  command: string;
  baseArgs: string[];
  description: string;
  /** False when the only way to launch it would involve a shell. */
  safe: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  installed: boolean;
  version: string | null;
  launcher: ProviderLauncher | null;
  models: string[];
  authenticatedUser: string | null;
  error: string | null;
}

/** Cost and code-change totals, in whatever unit the provider bills. */
export interface AgentUsage {
  credits?: number;
  filesModified?: string[];
  linesAdded?: number;
  linesRemoved?: number;
}

/**
 * A normalised event, so the run loop never parses a vendor's JSON shape.
 * One output line may yield several of these (a message carrying tool calls).
 */
export interface AgentEvent {
  kind: 'tool' | 'thinking' | 'message' | 'turn-start' | 'session' | 'usage' | 'warning' | 'other';
  text: string;
  sessionId?: string | null;
  outputTokens?: number;
  usage?: AgentUsage;
  /**
   * Marks an authoritative end-of-run report. A run that never emits one has
   * not told us what it cost, and must not be recorded as free.
   */
  terminal?: boolean;
}

export interface BuildArgsInput {
  prompt: string;
  model: string;
  /** Operator-configured additions to the built-in shell deny-list. */
  extraDeniedCommands: string[];
  /** Deny every file-writing tool (advisory read-only roles). */
  readOnly: boolean;
  allowedUrls: string[];
  extraDirs: string[];
  allowRepoInstructions: boolean;
  allowRepoMcp: boolean;
  sandbox: boolean;
  /** Our per-task ceiling, in the provider's own billing unit. */
  budget: number;
  /** Environment variable names the CLI should mask if echoed. */
  secretEnvVars: string[];
  /** Provider-specific extras; ignored by providers that lack them. */
  agent: string | null;
  effort: string | null;
  autopilot: boolean;
  maxAutopilotContinues: number;
}

export interface AgentProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  /** How the operator pays for this provider, shown in diagnostics. */
  readonly billing: string;
  readonly capabilities: ProviderCapabilities;

  detect(binOverride: string | null): Promise<ProviderInfo>;
  buildArgs(input: BuildArgsInput): string[];
  /** Translate one line of the CLI's output stream into normalised events. */
  parseLine(line: string): AgentEvent[];
  /**
   * Classify a non-zero exit from the CLI's own diagnostics, so the runner can
   * react to an auth failure differently from an exhausted allowance.
   */
  classifyFailure(diagnostics: string): FailureKind | null;
  /** True when a line hints at a quota condition while the run may still succeed. */
  looksLikeQuota(text: string): boolean;
}

export type FailureKind = 'auth-error' | 'model-unavailable' | 'quota-exhausted';

export interface CapabilityGap {
  capability: keyof ProviderCapabilities;
  consequence: string;
}

const CONSEQUENCES: Record<keyof ProviderCapabilities, string> = {
  denyShellCommands: 'the agent could run interpreters, package managers and network tools unchecked',
  denyFileWrites: 'the read-only survey and review passes could modify your code',
  allowUrlsByDomain: 'network access cannot be limited to specific domains',
  reportsUsage: 'spend cannot be measured, so the credit budgets cannot be enforced',
  ignoreRepoInstructions: 'a hostile repository could give the agent its own instructions',
  ignoreRepoMcp: 'a hostile repository could add its own tools through MCP',
  nativeBudgetCeiling: 'there is no in-process spend ceiling; only this application limits cost',
  sandbox: 'shell commands run with your full user rights',
};

/**
 * Which mandatory capabilities a provider lacks. A non-empty result must stop
 * the task rather than produce a warning nobody reads.
 */
export function missingCapabilities(provider: AgentProvider): CapabilityGap[] {
  return REQUIRED_CAPABILITIES.filter((c) => !provider.capabilities[c]).map((capability) => ({
    capability,
    consequence: CONSEQUENCES[capability],
  }));
}

export function describeCapabilityGaps(gaps: CapabilityGap[]): string {
  return gaps.map((g) => `  - cannot ${g.capability}: ${g.consequence}`).join('\n');
}
