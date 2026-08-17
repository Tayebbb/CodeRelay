import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerSecret } from './redact.js';
import type { LogLevel } from './logger.js';
import { isProviderId, PROVIDER_IDS, type ProviderId } from '../providers/types.js';

/** Repository root (this file lives at <root>/dist/src/core or <root>/src/core). */
export const PROJECT_ROOT = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // <root>/src/core  -> up 2 ; <root>/dist/src/core -> up 3
  const twoUp = path.resolve(here, '..', '..');
  if (fs.existsSync(path.join(twoUp, 'package.json'))) return twoUp;
  return path.resolve(here, '..', '..', '..');
})();

export interface AppConfig {
  telegram: {
    botToken: string;
    authorizedUserIds: number[];
    polling: boolean;
  };
  /** Which agent CLI drives the work. Validated against the provider registry. */
  provider: ProviderId;
  copilot: {
    bin: string | null;
    model: string;
    modelFallback: string | null;
    effort: string | null;
    agent: string | null;
    autopilot: boolean;
    maxAutopilotContinues: number;
    /** Run shell commands inside the CLI's experimental MXC sandbox. */
    sandbox: boolean;
  };
  limits: {
    maxAiCreditsPerTask: number;
    maxAiCreditsPerDay: number;
    maxTaskDurationMs: number;
    maxRetries: number;
    maxConcurrentTasks: number;
    verifyTimeoutMs: number;
    approvalTimeoutMs: number;
  };
  git: {
    autoCommit: boolean;
    autoPush: boolean;
    checkpoint: boolean;
    requireApprovalWhenDirty: boolean;
    protectedBranches: string[];
    /** Permit an auto-commit when the project declares no test/build command. */
    allowCommitWithoutVerification: boolean;
  };
  safety: {
    requireApprovalForDangerousActions: boolean;
    extraDeniedCommands: string[];
    allowedUrls: string[];
    /** Extra environment variables to forward to the Copilot child process. */
    envPassthrough: string[];
    /** Let the target repository's AGENTS.md etc. act as agent instructions. */
    allowRepoInstructions: boolean;
    /** Keep the built-in GitHub MCP server enabled. */
    githubMcp: boolean;
  };
  verify: {
    runTests: boolean;
    runBuild: boolean;
  };
  orchestration: {
    /** Allow explorer/reviewer passes at all. Off = one implementer session. */
    enabled: boolean;
    /** Hard ceiling on paid Copilot sessions per task, retries included. */
    maxAgentCalls: number;
    /** Below this confidence a review pass is worth its credits. */
    reviewThreshold: number;
  };
  storage: {
    workspace: string;
    databaseFile: string;
    logDirectory: string;
    projectsFile: string;
  };
  /** Each interface is an optional client of the same core. */
  interfaces: {
    telegram: boolean;
    web: boolean;
  };
  web: {
    host: string;
    port: number;
    sessionTtlMs: number;
    /** Password hash file; created by `remote-agent web setup`. */
    authFile: string;
  };
  logLevel: LogLevel;
}

export class ConfigError extends Error {}

function env(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

function bool(key: string, fallback: boolean): boolean {
  const v = env(key);
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(key: string, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number {
  const v = env(key);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new ConfigError(`${key} must be an integer, got "${v}"`);
  if (n < min || n > max) throw new ConfigError(`${key} must be between ${min} and ${max}, got ${n}`);
  return n;
}

function num(key: string, fallback: number, { min = 0 } = {}): number {
  const v = env(key);
  if (v === undefined) return fallback;
  const n = Number.parseFloat(v);
  if (Number.isNaN(n)) throw new ConfigError(`${key} must be a number, got "${v}"`);
  if (n < min) throw new ConfigError(`${key} must be >= ${min}, got ${n}`);
  return n;
}

function list(key: string, fallback: string[] = []): string[] {
  const v = env(key);
  if (v === undefined) return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Load `.env` from the repository root if present. Safe to call repeatedly. */
export function loadEnvFile(root: string = PROJECT_ROOT): void {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch {
    // Malformed .env should surface as missing-config errors, not a hard crash here.
  }
}

const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// Node timers overflow past 2^31-1 ms and fire IMMEDIATELY; an operator asking
// for a huge limit means "effectively unlimited", so clamp instead of reject.
const MAX_TIMER_MS = 2 ** 31 - 1;
const clampMs = (ms: number): number => Math.min(ms, MAX_TIMER_MS);

export interface LoadOptions {
  /** Skip validation of Telegram credentials (used by `doctor` and offline CLI commands). */
  requireTelegram?: boolean;
}

export function loadConfig(options: LoadOptions = {}): AppConfig {
  const requireTelegram = options.requireTelegram !== false;

  const botToken = env('TELEGRAM_BOT_TOKEN') ?? '';
  const rawIds = list('AUTHORIZED_TELEGRAM_USER_ID');
  const authorizedUserIds = rawIds.map((id) => {
    const n = Number.parseInt(id, 10);
    if (Number.isNaN(n) || n <= 0) {
      throw new ConfigError(`AUTHORIZED_TELEGRAM_USER_ID contains a non-numeric entry: "${id}"`);
    }
    return n;
  });

  const telegramEnabled = bool('TELEGRAM_ENABLED', botToken !== '');
  const webEnabled = bool('WEB_ENABLED', false);

  // Credentials are demanded only for the interface the operator turned on. A
  // web-only install must never be forced to create a Telegram bot.
  if (requireTelegram && telegramEnabled) {
    if (!botToken) {
      throw new ConfigError(
        'TELEGRAM_ENABLED is on but TELEGRAM_BOT_TOKEN is not set. Fill it in, or set TELEGRAM_ENABLED=false.',
      );
    }
    if (authorizedUserIds.length === 0) {
      throw new ConfigError(
        'AUTHORIZED_TELEGRAM_USER_ID is not set. Without it the bot would accept commands from anybody — refusing to start.',
      );
    }
  }
  registerSecret(botToken);

  const effort = env('COPILOT_EFFORT') ?? null;
  if (effort && !EFFORT_LEVELS.includes(effort)) {
    throw new ConfigError(`COPILOT_EFFORT must be one of ${EFFORT_LEVELS.join(', ')}`);
  }

  // NB: deliberately NOT `COPILOT_AGENT` — VS Code's integrated terminal injects
  // that name with an unrelated value, which would be passed to `--agent`.
  const requestedAgent = env('COPILOT_CUSTOM_AGENT') ?? 'remote-engineer';
  if (requestedAgent !== 'none' && !/^[A-Za-z][A-Za-z0-9._-]*$/.test(requestedAgent)) {
    throw new ConfigError(
      `COPILOT_CUSTOM_AGENT must be an agent name (letters, digits, dot, dash, underscore) or "none"; got "${requestedAgent}"`,
    );
  }

  const workspace = path.resolve(env('AGENT_WORKSPACE') ?? path.join(PROJECT_ROOT, 'data'));
  const projectsFile = path.resolve(env('PROJECTS_FILE') ?? path.join(PROJECT_ROOT, 'config', 'projects.json'));

  const logLevel = (env('LOG_LEVEL') ?? 'info') as LogLevel;
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new ConfigError('LOG_LEVEL must be one of debug, info, warn, error');
  }

  // An unrecognised provider must stop startup rather than silently fall back
  // to Copilot: the operator would believe a different CLI was in use.
  const provider = env('AGENT_PROVIDER') ?? 'copilot';
  if (!isProviderId(provider)) {
    throw new ConfigError(`AGENT_PROVIDER must be one of ${PROVIDER_IDS.join(', ')}; got "${provider}"`);
  }

  return {
    telegram: {
      botToken,
      authorizedUserIds,
      polling: bool('TELEGRAM_POLLING', true),
    },
    provider,
    copilot: {
      bin: env('COPILOT_BIN') ?? null,
      model: env('COPILOT_MODEL') ?? 'claude-opus-5',
      modelFallback: env('COPILOT_MODEL_FALLBACK') ?? 'claude-opus-4.8',
      effort,
      agent: requestedAgent === 'none' ? null : requestedAgent,
      autopilot: bool('COPILOT_AUTOPILOT', true),
      maxAutopilotContinues: int('MAX_AUTOPILOT_CONTINUES', 5, { min: 1 }),
      sandbox: bool('COPILOT_SANDBOX', false),
    },
    limits: {
      maxAiCreditsPerTask: num('MAX_AI_CREDITS_PER_TASK', 10),
      maxAiCreditsPerDay: num('MAX_AI_CREDITS_PER_DAY', 50),
      maxTaskDurationMs: clampMs(int('MAX_TASK_DURATION_MINUTES', 30, { min: 1 }) * 60_000),
      maxRetries: int('MAX_RETRIES', 2, { min: 0 }),
      maxConcurrentTasks: int('MAX_CONCURRENT_TASKS', 1, { min: 1 }),
      verifyTimeoutMs: clampMs(int('VERIFY_TIMEOUT_MINUTES', 15, { min: 1 }) * 60_000),
      approvalTimeoutMs: clampMs(int('APPROVAL_TIMEOUT_MINUTES', 60, { min: 1 }) * 60_000),
    },
    git: {
      autoCommit: bool('AUTO_COMMIT', true),
      autoPush: bool('AUTO_PUSH', false),
      checkpoint: bool('GIT_CHECKPOINT', true),
      requireApprovalWhenDirty: bool('REQUIRE_APPROVAL_WHEN_DIRTY', true),
      protectedBranches: list('PROTECTED_BRANCHES', ['main', 'master', 'production', 'release']),
      allowCommitWithoutVerification: bool('ALLOW_COMMIT_WITHOUT_VERIFICATION', false),
    },
    safety: {
      requireApprovalForDangerousActions: bool('REQUIRE_APPROVAL_FOR_DANGEROUS_ACTIONS', true),
      extraDeniedCommands: list('EXTRA_DENIED_COMMANDS'),
      envPassthrough: list('COPILOT_ENV_PASSTHROUGH'),
      allowRepoInstructions: bool('COPILOT_REPO_INSTRUCTIONS', false),
      githubMcp: bool('COPILOT_GITHUB_MCP', false),
      allowedUrls: list('ALLOWED_URLS', [
        'registry.npmjs.org',
        'pypi.org',
        'files.pythonhosted.org',
        'objects.githubusercontent.com',
        'github.com',
      ]),
    },
    verify: {
      runTests: bool('RUN_TESTS', true),
      runBuild: bool('RUN_BUILD', true),
    },
    orchestration: {
      enabled: bool('ORCHESTRATION', true),
      maxAgentCalls: int('MAX_AGENT_CALLS_PER_TASK', 4, { min: 1 }),
      reviewThreshold: num('REVIEW_CONFIDENCE_THRESHOLD', 0.75),
    },
    storage: {
      workspace,
      databaseFile: path.join(workspace, 'agent.db'),
      logDirectory: path.join(workspace, 'logs'),
      projectsFile,
    },
    interfaces: {
      telegram: telegramEnabled,
      web: webEnabled,
    },
    web: {
      // Localhost by default. Exposing this any wider is an explicit decision
      // documented under "Remote access", never an accident of installation.
      host: env('WEB_HOST') ?? '127.0.0.1',
      // The port range is a TCP fact, not a preference — it stays validated.
      port: int('WEB_PORT', 8787, { min: 1, max: 65535 }),
      sessionTtlMs: int('WEB_SESSION_TTL_HOURS', 24 * 7, { min: 1 }) * 60 * 60 * 1000,
      authFile: path.join(workspace, 'web-auth.json'),
    },
    logLevel,
  };
}

/** Load `.env` then build the config. */
export function bootstrapConfig(options: LoadOptions = {}): AppConfig {
  loadEnvFile();
  const config = loadConfig(options);
  fs.mkdirSync(config.storage.workspace, { recursive: true });
  fs.mkdirSync(config.storage.logDirectory, { recursive: true });
  return config;
}
