/**
 * Secret redaction. Every string that leaves the process (Telegram message, log
 * line, stored task record) passes through `redact()`.
 *
 * This is defence-in-depth, not a guarantee: the primary protection is that we
 * never deliberately read `.env` files or credential stores.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Literal secret values registered at runtime (bot token, etc.). */
const literalSecrets = new Set<string>();

/** Register a value that must never appear in output. Short values are ignored. */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value === 'string' && value.trim().length >= 8) {
    literalSecrets.add(value.trim());
  }
}

export function clearRegisteredSecrets(): void {
  literalSecrets.clear();
}

const PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // GitHub tokens (classic, fine-grained, OAuth, app, refresh)
  { re: /\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  // Telegram bot tokens: 123456789:AA...
  { re: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, replacement: '[REDACTED_TELEGRAM_TOKEN]' },
  // Common vendor API keys
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: '[REDACTED_API_KEY]' },
  { re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, replacement: '[REDACTED_API_KEY]' },
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replacement: '[REDACTED_API_KEY]' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED_AWS_KEY]' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED_SLACK_TOKEN]' },
  // Private key blocks
  {
    re: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  // JWTs
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: '[REDACTED_JWT]' },
  // KEY=value assignments for suspicious names (dotenv-style lines)
  {
    re: /\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIAL|ACCESS_?KEY|CLIENT_?SECRET|DSN)[A-Z0-9_]*)\s*[:=]\s*("[^"\n]*"|'[^'\n]*'|[^\s,;)}\]]+)/gi,
    replacement: '$1=[REDACTED]',
  },
  // Connection strings with inline credentials
  { re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@]+)@/gi, replacement: '$1$2:[REDACTED]@' },
  // Authorization headers
  { re: /\b(authorization|proxy-authorization)\s*[:=]\s*\S+/gi, replacement: '$1: [REDACTED]' },
];

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove known secrets and secret-shaped substrings from `input`. */
export function redact(input: string): string {
  if (!input) return input;
  let out = input;

  for (const secret of literalSecrets) {
    out = out.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }
  for (const { re, replacement } of PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/** Deep-redact an arbitrary structure for safe logging. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** File names whose contents must never be surfaced. */
const SENSITIVE_FILE_RE =
  /(^|[\\/])(\.env(\.[\w.-]+)?|\.npmrc|\.netrc|id_[a-z0-9]+|.*\.pem|.*\.p12|.*\.pfx|.*\.keystore|credentials(\.json)?|secrets?\.(ya?ml|json|toml))$/i;

export function isSensitiveFile(filePath: string): boolean {
  return SENSITIVE_FILE_RE.test(filePath.replace(/\\/g, '/'));
}

/** Secret-bearing files we read ONLY to learn what must never be echoed. */
const SECRET_SOURCE_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.npmrc',
  '.netrc',
];

/** Ceiling on values learned from an untrusted repository. */
const MAX_PROJECT_SECRETS = 200;

/**
 * Learn the project's own secret values so `redact()` can strip them.
 *
 * Pattern matching cannot recognise an arbitrary value like
 * `DB_PASSWORD=correct-horse`. Reading the project's `.env` lets us register the
 * literal values, so if the agent ever echoes one it is removed from every
 * message, log and stored record. The values are held in memory only and are
 * never written anywhere.
 */
export function registerProjectSecrets(root: string): number {
  let learned = 0;

  for (const name of SECRET_SOURCE_FILES) {
    let contents: string;
    try {
      contents = fs.readFileSync(path.join(root, name), 'utf8');
    } catch {
      continue;
    }

    for (const rawLine of contents.split(/\r?\n/)) {
      // The file belongs to a repository we do not trust. redact() compiles one
      // regex per secret per call and runs on every progress event, so an
      // enormous .env would both stall the bot and blank out so much text that
      // the operator loses visibility. Learn a bounded number and stop.
      if (learned >= MAX_PROJECT_SECRETS) return learned;

      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const match = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*[:=]\s*(.*)$/.exec(line);
      const value = (match?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
      // Short or obviously non-secret values would cause noisy over-redaction.
      if (value.length >= 8 && !/^(true|false|localhost|undefined|null)$/i.test(value)) {
        registerSecret(value);
        learned += 1;
      }
    }
  }

  return learned;
}
