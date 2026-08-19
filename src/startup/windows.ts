/**
 * Windows auto-start management: install / status / remove for the per-user
 * Scheduled Task that starts the agent at logon.
 *
 * This deliberately wraps the committed PowerShell scripts rather than
 * re-expressing the task definition here: those scripts are the single source
 * of truth for the restart policy and the security posture (non-elevated,
 * interactive token, IgnoreNew). Everything is spawned with `shell: false`
 * and constant argv — no user-controlled text ever reaches a shell.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/config.js';
import { execCommand } from '../util/exec.js';

export const STARTUP_TASK_NAME = 'RemotePersonalCodingAgent';

/** Absolute path so a hijacked PATH cannot substitute another powershell. */
export function powershellExe(systemRoot: string = process.env.SystemRoot ?? 'C:\\Windows'): string {
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function startupSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

export function installScriptPath(root: string = PROJECT_ROOT): string {
  return path.join(root, 'scripts', 'install-startup.ps1');
}

export function uninstallScriptPath(root: string = PROJECT_ROOT): string {
  return path.join(root, 'scripts', 'uninstall-startup.ps1');
}

/**
 * The built entry point the scheduled task will run. Checked before install so
 * "installed but never starts" cannot happen silently.
 */
export function validateBuilt(root: string = PROJECT_ROOT): string | null {
  const entry = path.join(root, 'dist', 'src', 'main.js');
  if (!fs.existsSync(entry)) {
    return `Not built yet: ${entry} does not exist. Run "npm install" and "npm run build" first.`;
  }
  return null;
}

export function installArgv(nodeExe: string, root: string = PROJECT_ROOT): string[] {
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installScriptPath(root), '-NodeExe', nodeExe];
}

export function uninstallArgv(root: string = PROJECT_ROOT): string[] {
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', uninstallScriptPath(root)];
}

/** Constant query — the task name is a compile-time constant, never user input. */
const QUERY_COMMAND =
  `$t = Get-ScheduledTask -TaskName '${STARTUP_TASK_NAME}' -ErrorAction Stop; ` +
  `$i = $t | Get-ScheduledTaskInfo; ` +
  `[pscustomobject]@{ state = [string]$t.State; restartCount = $t.Settings.RestartCount; ` +
  `restartInterval = [string]$t.Settings.RestartInterval; execute = $t.Actions[0].Execute; ` +
  `arguments = $t.Actions[0].Arguments; workingDirectory = $t.Actions[0].WorkingDirectory; ` +
  `triggerCount = @($t.Triggers).Count; ` +
  `triggerTypes = (@($t.Triggers) | ForEach-Object { $_.CimClass.CimClassName }) -join ','; ` +
  `lastTaskResult = $i.LastTaskResult; lastRunTime = [string]$i.LastRunTime } | ConvertTo-Json`;

export function queryArgv(): string[] {
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', QUERY_COMMAND];
}

export interface ScheduledTaskFacts {
  state: string;
  restartCount: number | null;
  restartInterval: string | null;
  execute: string;
  arguments: string;
  workingDirectory: string;
  /** Null when queried from a build that predates the watchdog trigger. */
  triggerCount: number | null;
  triggerTypes: string;
  lastTaskResult: number | null;
  lastRunTime: string;
}

export function parseTaskFacts(stdout: string): ScheduledTaskFacts | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return {
      state: typeof parsed.state === 'string' ? parsed.state : 'Unknown',
      restartCount: typeof parsed.restartCount === 'number' ? parsed.restartCount : null,
      restartInterval: typeof parsed.restartInterval === 'string' ? parsed.restartInterval : null,
      execute: typeof parsed.execute === 'string' ? parsed.execute : '',
      arguments: typeof parsed.arguments === 'string' ? parsed.arguments : '',
      workingDirectory: typeof parsed.workingDirectory === 'string' ? parsed.workingDirectory : '',
      triggerCount: typeof parsed.triggerCount === 'number' ? parsed.triggerCount : null,
      triggerTypes: typeof parsed.triggerTypes === 'string' ? parsed.triggerTypes : '',
      lastTaskResult: typeof parsed.lastTaskResult === 'number' ? parsed.lastTaskResult : null,
      lastRunTime: typeof parsed.lastRunTime === 'string' ? parsed.lastRunTime : '',
    };
  } catch {
    return null;
  }
}

/** Null when the task is not registered. Throws only on unexpected failures. */
export async function queryTask(): Promise<ScheduledTaskFacts | null> {
  const result = await execCommand(powershellExe(), queryArgv(), {
    cwd: PROJECT_ROOT,
    timeoutMs: 30_000,
    shell: false,
  });
  if (result.code !== 0) return null;
  return parseTaskFacts(result.stdout);
}

export interface StartupActionResult {
  ok: boolean;
  output: string;
}

export async function runInstall(nodeExe: string, root: string = PROJECT_ROOT): Promise<StartupActionResult> {
  const result = await execCommand(powershellExe(), installArgv(nodeExe, root), {
    cwd: root,
    timeoutMs: 60_000,
    shell: false,
  });
  return { ok: result.code === 0, output: `${result.stdout}\n${result.stderr}`.trim() };
}

export async function runUninstall(root: string = PROJECT_ROOT): Promise<StartupActionResult> {
  const result = await execCommand(powershellExe(), uninstallArgv(root), {
    cwd: root,
    timeoutMs: 60_000,
    shell: false,
  });
  return { ok: result.code === 0, output: `${result.stdout}\n${result.stderr}`.trim() };
}
