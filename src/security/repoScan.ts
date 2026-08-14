import fs from 'node:fs';
import path from 'node:path';

/**
 * Detects Copilot configuration supplied by the TARGET REPOSITORY.
 *
 * The CLI resolves several things relative to its working directory — which is
 * the project we are about to work on. Verified against Copilot CLI 1.0.79:
 *
 *  - `.github/agents/*.md` are discovered from the repo. A repo can therefore
 *    ship an agent whose name collides with ours and replace the security
 *    instructions the whole design depends on.
 *  - `.github/hooks/*.json` are repo-level hooks and `disableAllHooks` defaults
 *    to false. There is no CLI flag to turn them off, so a repo can name
 *    commands that run around agent events.
 *  - `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md` and friends are
 *    loaded as INSTRUCTIONS, not data — classic indirect prompt injection. We
 *    pass `--no-custom-instructions` by default, so these are reported but not
 *    blocking.
 *
 * None of this is the agent misbehaving; it is configuration the CLI honours
 * before the agent gets a say. So it is checked before Copilot is launched.
 */

export type RepoConfigSeverity = 'blocking' | 'notice';

export interface RepoConfigFinding {
  severity: RepoConfigSeverity;
  path: string;
  what: string;
}

export interface RepoScanResult {
  findings: RepoConfigFinding[];
  blocking: RepoConfigFinding[];
  notices: RepoConfigFinding[];
}

/** Directories whose every file is loaded as agent capability from the repo. */
const CAPABILITY_DIRS: Array<{ dir: string; what: string; recursive?: boolean }> = [
  { dir: '.github/agents', what: 'defines a Copilot agent from inside the repository' },
  { dir: '.github/hooks', what: 'repository hook — names commands the CLI runs around agent events' },
  // Skills are instructions PLUS an `allowed-tools` list that can auto-approve
  // tools the deny-list is meant to gate. `--no-custom-instructions` does not
  // cover them.
  { dir: '.github/skills', what: 'repository skill — instructions and tool auto-approvals', recursive: true },
  { dir: '.agents/skills', what: 'repository skill — instructions and tool auto-approvals', recursive: true },
  { dir: '.claude/skills', what: 'repository skill — instructions and tool auto-approvals', recursive: true },
];

/** Single files that declare external tools, servers or plugins. */
const CAPABILITY_FILES: Array<{ file: string; what: string }> = [
  { file: '.mcp.json', what: 'declares MCP servers — external commands outside the URL and tool policy' },
  { file: '.github/mcp.json', what: 'declares MCP servers — external commands outside the URL and tool policy' },
  { file: '.vscode/mcp.json', what: 'declares MCP servers' },
  { file: 'mcp-config.json', what: 'declares MCP servers' },
  { file: '.copilot/mcp-config.json', what: 'declares MCP servers' },
  { file: '.github/lsp.json', what: 'declares language servers — commands the CLI spawns' },
  { file: 'plugin.json', what: 'declares a Copilot plugin' },
  { file: '.plugin/plugin.json', what: 'declares a Copilot plugin' },
  { file: '.github/plugin/plugin.json', what: 'declares a Copilot plugin' },
  { file: '.claude-plugin/plugin.json', what: 'declares a Copilot plugin' },
  { file: 'marketplace.json', what: 'declares a plugin marketplace' },
  { file: '.plugin/marketplace.json', what: 'declares a plugin marketplace' },
  { file: '.github/plugin/marketplace.json', what: 'declares a plugin marketplace' },
  { file: '.claude-plugin/marketplace.json', what: 'declares a plugin marketplace' },
];

/** Settings files that can carry hooks, plugins or extra marketplaces. */
const SETTINGS_FILES = [
  'settings.json',
  '.copilot/settings.json',
  '.github/copilot/settings.json',
  '.github/copilot/settings.local.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
];

const SETTINGS_DANGER_KEYS = ['hooks', 'enabledPlugins', 'extraKnownMarketplaces'];

/** Files loaded as agent instructions when custom instructions are enabled. */
const INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.github/copilot-instructions.md',
  '.cursorrules',
];

const INSTRUCTION_DIRS = ['.github/instructions'];

function exists(root: string, relative: string): boolean {
  try {
    return fs.existsSync(path.join(root, relative));
  } catch {
    return false;
  }
}

function listFiles(root: string, relative: string, recursive = false): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isFile()) out.push(child);
      else if (recursive && entry.isDirectory()) walk(child, depth + 1);
    }
  };
  walk(relative, 0);
  return out;
}

export interface RepoScanOptions {
  /** The agent name we rely on; a repo defining it is treated as an override. */
  agentName: string | null;
  /** True when repo instruction files are deliberately allowed. */
  allowRepoInstructions: boolean;
}

export function scanRepositoryConfig(root: string, options: RepoScanOptions): RepoScanResult {
  const findings: RepoConfigFinding[] = [];

  for (const file of listFiles(root, '.github/agents')) {
    const base = path.basename(file, '.md').toLowerCase();
    const isOverride = options.agentName !== null && base === options.agentName.toLowerCase();
    findings.push({
      severity: 'blocking',
      path: file,
      what: isOverride
        ? `redefines the "${options.agentName}" agent this system relies on for its safety rules`
        : 'defines a Copilot agent from inside the repository',
    });
  }

  for (const entry of CAPABILITY_DIRS) {
    if (entry.dir === '.github/agents') continue;
    for (const file of listFiles(root, entry.dir, entry.recursive)) {
      findings.push({ severity: 'blocking', path: file, what: entry.what });
    }
  }

  for (const entry of CAPABILITY_FILES) {
    if (exists(root, entry.file)) {
      findings.push({ severity: 'blocking', path: entry.file, what: entry.what });
    }
  }

  for (const file of SETTINGS_FILES) {
    if (!exists(root, file)) continue;
    let dangerous = false;
    let unreadable = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) as Record<string, unknown>;
      dangerous = SETTINGS_DANGER_KEYS.some((key) => key in parsed) || parsed.disableAllHooks === false;
    } catch {
      // Fail CLOSED. The CLI's parser is more forgiving than JSON.parse (BOM,
      // trailing commas, comments), so "we could not read it" must not be
      // reported as "it is safe" — that is exactly how a payload gets waved
      // through.
      unreadable = true;
    }
    if (dangerous || unreadable) {
      findings.push({
        severity: 'blocking',
        path: file,
        what: unreadable
          ? 'repository settings file could not be parsed, so its contents cannot be cleared'
          : 'repository settings define hooks, plugins or extra marketplaces',
      });
    }
  }

  if (!options.allowRepoInstructions) {
    for (const file of INSTRUCTION_FILES) {
      if (exists(root, file)) {
        findings.push({
          severity: 'notice',
          path: file,
          what: 'instruction file present; not loaded (--no-custom-instructions)',
        });
      }
    }
    for (const dir of INSTRUCTION_DIRS) {
      for (const file of listFiles(root, dir)) {
        findings.push({ severity: 'notice', path: file, what: 'instruction file present; not loaded' });
      }
    }
  } else {
    for (const file of INSTRUCTION_FILES) {
      if (exists(root, file)) {
        findings.push({
          severity: 'blocking',
          path: file,
          what: 'loaded as agent INSTRUCTIONS because COPILOT_REPO_INSTRUCTIONS is enabled',
        });
      }
    }
  }

  return {
    findings,
    blocking: findings.filter((f) => f.severity === 'blocking'),
    notices: findings.filter((f) => f.severity === 'notice'),
  };
}

export function describeRepoFindings(findings: RepoConfigFinding[]): string[] {
  return findings.map((f) => `${f.path} — ${f.what}`);
}
