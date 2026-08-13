import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/config.js';

/**
 * The Copilot CLI discovers custom agents from `<cwd>/.github/agents/*.md` and
 * from `<COPILOT_HOME>/agents/*.md` (verified against CLI 1.0.63).
 *
 * Because each task runs with the working directory set to the target project,
 * a repo-local agent would only apply to this repository. Installing it at the
 * user level makes it available for every registered project WITHOUT modifying
 * any of your project repositories.
 */

export const AGENT_NAME = 'remote-engineer';

export function copilotHome(): string {
  return process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
}

export function agentSourcePath(): string {
  return path.join(PROJECT_ROOT, '.github', 'agents', `${AGENT_NAME}.md`);
}

export function agentTargetPath(): string {
  return path.join(copilotHome(), 'agents', `${AGENT_NAME}.md`);
}

export function isAgentInstalled(): boolean {
  return fs.existsSync(agentTargetPath());
}

export interface InstallResult {
  installed: boolean;
  target: string;
  changed: boolean;
  error?: string;
}

/** Copy the custom agent into the user-level Copilot agents directory. */
export function installAgent(): InstallResult {
  const source = agentSourcePath();
  const target = agentTargetPath();

  if (!fs.existsSync(source)) {
    return { installed: false, target, changed: false, error: `Agent definition missing at ${source}` };
  }
  try {
    const content = fs.readFileSync(source, 'utf8');
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (existing === content) return { installed: true, target, changed: false };

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    return { installed: true, target, changed: true };
  } catch (err) {
    return { installed: false, target, changed: false, error: (err as Error).message };
  }
}

export function uninstallAgent(): boolean {
  const target = agentTargetPath();
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { force: true });
  return true;
}
