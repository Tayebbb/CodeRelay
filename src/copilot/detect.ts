import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * How to launch the Copilot CLI.
 *
 * We strongly prefer resolving the package's JS entry point so we can spawn
 * `node npm-loader.js …` with an argument ARRAY and `shell: false`. That makes
 * shell metacharacters in a user prompt inert. Falling back to a `.cmd`/`.ps1`
 * shim would require `shell: true`, which we refuse to do.
 */
export interface CopilotLauncher {
  command: string;
  baseArgs: string[];
  /** Human-readable description of what was resolved. */
  description: string;
  /** True when the launcher is shell-free (safe for untrusted prompt text). */
  safe: boolean;
}

export interface CopilotInfo {
  installed: boolean;
  version: string | null;
  launcher: CopilotLauncher | null;
  /** Model ids advertised by this exact CLI build. */
  models: string[];
  authenticatedUser: string | null;
  configHome: string;
  error?: string;
}

function pathEntries(): string[] {
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
}

function existsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Candidate directories that may contain a global `@github/copilot` install. */
function candidateModuleRoots(): string[] {
  const roots: string[] = [];
  for (const dir of pathEntries()) {
    roots.push(path.join(dir, 'node_modules'));
    roots.push(path.join(dir, '..', 'lib', 'node_modules'));
  }
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  roots.push(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'));
  roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules', '/opt/homebrew/lib/node_modules');
  return roots;
}

function findPackageEntry(): string | null {
  for (const root of candidateModuleRoots()) {
    for (const entry of ['npm-loader.js', 'index.js']) {
      const candidate = path.join(root, '@github', 'copilot', entry);
      if (existsFile(candidate)) return path.resolve(candidate);
    }
  }
  return null;
}

function findExecutable(): string | null {
  const names = process.platform === 'win32' ? ['copilot.exe'] : ['copilot'];
  for (const dir of pathEntries()) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsFile(candidate)) return path.resolve(candidate);
    }
  }
  return null;
}

/** Resolve how to launch Copilot, honouring an explicit override. */
export function resolveLauncher(override?: string | null): CopilotLauncher | null {
  if (override) {
    const resolved = path.resolve(override);
    if (!existsFile(resolved)) return null;
    if (resolved.endsWith('.js')) {
      return {
        command: process.execPath,
        baseArgs: [resolved],
        description: `node ${resolved}`,
        safe: true,
      };
    }
    if (resolved.endsWith('.cmd') || resolved.endsWith('.ps1') || resolved.endsWith('.bat')) {
      return { command: resolved, baseArgs: [], description: resolved, safe: false };
    }
    return { command: resolved, baseArgs: [], description: resolved, safe: true };
  }

  const entry = findPackageEntry();
  if (entry) {
    return {
      command: process.execPath,
      baseArgs: [entry],
      description: `node ${entry}`,
      safe: true,
    };
  }

  const exe = findExecutable();
  if (exe) return { command: exe, baseArgs: [], description: exe, safe: true };

  return null;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runLauncher(
  launcher: CopilotLauncher,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(launcher.command, [...launcher.baseArgs, ...args], {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: '1', ...options.env },
      shell: !launcher.safe,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 60_000);

    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), code: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Parse the model catalogue out of `copilot help config`. The CLI prints:
 *   `model`: AI model to use ...
 *       - "claude-opus-4.8"
 *       - "gpt-5.5"
 */
export function parseModels(helpConfigOutput: string): string[] {
  const lines = helpConfigOutput.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*`model`\s*:/.test(l));
  if (start === -1) return [];

  const models: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const match = /^\s*-\s*"([^"]+)"\s*$/.exec(line);
    if (match) {
      models.push(match[1]!);
      continue;
    }
    if (line.trim() === '') continue;
    break;
  }
  return models;
}

export function parseVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(output);
  return match ? match[1]! : null;
}

function copilotHome(): string {
  return process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
}

function readAuthenticatedUser(): string | null {
  if (process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    return '(token from environment)';
  }
  try {
    const raw = fs.readFileSync(path.join(copilotHome(), 'config.json'), 'utf8');
    const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as {
      lastLoggedInUser?: { login?: string };
    };
    return json.lastLoggedInUser?.login ?? null;
  } catch {
    return null;
  }
}

/** Probe the installed Copilot CLI. Performs no AI calls and costs nothing. */
export async function detectCopilot(override?: string | null): Promise<CopilotInfo> {
  const launcher = resolveLauncher(override);
  const configHome = copilotHome();

  if (!launcher) {
    return {
      installed: false,
      version: null,
      launcher: null,
      models: [],
      authenticatedUser: readAuthenticatedUser(),
      configHome,
      error: 'Copilot CLI not found. Install with: npm install -g @github/copilot',
    };
  }

  const versionRun = await runLauncher(launcher, ['--version'], { timeoutMs: 45_000 });
  const version = parseVersion(versionRun.stdout + versionRun.stderr);

  const helpRun = await runLauncher(launcher, ['help', 'config'], { timeoutMs: 45_000 });
  const models = parseModels(helpRun.stdout + helpRun.stderr);

  return {
    installed: version !== null,
    version,
    launcher,
    models,
    authenticatedUser: readAuthenticatedUser(),
    configHome,
    error: version === null ? `Could not read Copilot CLI version (exit ${versionRun.code})` : undefined,
  };
}

export interface ModelSelection {
  model: string;
  requested: string;
  fellBack: boolean;
  available: boolean;
  note: string | null;
}

/**
 * Choose a model id that the installed CLI actually understands.
 * Never invents a model: if the requested one is absent we either fall back to a
 * configured alternative or report the problem, and always explain what happened.
 */
export function selectModel(requested: string, fallback: string | null, available: string[]): ModelSelection {
  if (available.length === 0) {
    return {
      model: requested,
      requested,
      fellBack: false,
      available: true,
      note: 'Could not read the CLI model catalogue; passing the configured model through unchecked.',
    };
  }
  if (available.includes(requested)) {
    return { model: requested, requested, fellBack: false, available: true, note: null };
  }
  if (fallback && available.includes(fallback)) {
    return {
      model: fallback,
      requested,
      fellBack: true,
      available: false,
      note: `Model "${requested}" is not offered by this Copilot CLI build. Using "${fallback}" instead. Available: ${available.join(', ')}`,
    };
  }
  return {
    model: requested,
    requested,
    fellBack: false,
    available: false,
    note: `Model "${requested}" is not offered by this Copilot CLI build and no usable fallback is configured. Available: ${available.join(', ')}`,
  };
}
