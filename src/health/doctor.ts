import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execCommand } from '../util/exec.js';
import { detectCopilot, selectModel, type CopilotInfo } from '../copilot/detect.js';
import { describeCapabilityGaps, missingCapabilities, selectProvider } from '../providers/index.js';
import { AGENT_NAME, agentTargetPath, isAgentInstalled } from '../copilot/agentInstall.js';
import { ProjectRegistry } from '../projects/registry.js';
import { Git } from '../git/git.js';
import { detectCommands } from '../verify/detector.js';
import { bootstrapConfig, ConfigError, PROJECT_ROOT, type AppConfig } from '../core/config.js';
import { openDatabase } from '../db/database.js';
import { errorMessage } from '../core/logger.js';
import { queryTask, startupSupported, STARTUP_TASK_NAME } from '../startup/windows.js';
import { isProcessAlive } from '../core/lock.js';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

const ICON: Record<CheckStatus, string> = { pass: '✔', warn: '!', fail: '✖', skip: '·' };

async function which(command: string, args: string[] = ['--version']): Promise<string | null> {
  const result = await execCommand(command, args, {
    cwd: process.cwd(),
    timeoutMs: 20_000,
    shell: process.platform === 'win32',
  });
  if (result.code !== 0) return null;
  return (result.stdout + result.stderr).trim().split(/\r?\n/)[0] ?? '';
}

async function checkInternet(): Promise<CheckResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const response = await fetch('https://api.github.com/zen', { signal: controller.signal });
    clearTimeout(timer);
    return response.ok
      ? { name: 'Internet connectivity', status: 'pass', detail: 'github.com reachable' }
      : { name: 'Internet connectivity', status: 'warn', detail: `github.com responded ${response.status}` };
  } catch (err) {
    return {
      name: 'Internet connectivity',
      status: 'fail',
      detail: errorMessage(err),
      hint: 'The agent needs outbound HTTPS to reach Telegram and Copilot. No inbound port is required.',
    };
  }
}

async function checkTelegram(config: AppConfig): Promise<CheckResult> {
  if (!config.telegram.botToken) {
    return {
      name: 'Telegram bot',
      status: 'fail',
      detail: 'TELEGRAM_BOT_TOKEN is not set',
      hint: 'Create a bot with @BotFather and put the token in .env',
    };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/getMe`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = (await response.json()) as { ok?: boolean; result?: { username?: string }; description?: string };
    if (!body.ok) {
      return { name: 'Telegram bot', status: 'fail', detail: body.description ?? 'getMe failed' };
    }
    return { name: 'Telegram bot', status: 'pass', detail: `@${body.result?.username ?? 'unknown'} reachable` };
  } catch (err) {
    return { name: 'Telegram bot', status: 'fail', detail: errorMessage(err) };
  }
}

function checkAuthorizedUsers(config: AppConfig): CheckResult {
  if (config.telegram.authorizedUserIds.length === 0) {
    return {
      name: 'Authorized users',
      status: 'fail',
      detail: 'AUTHORIZED_TELEGRAM_USER_ID is empty — the bot would refuse everyone',
      hint: 'Get your numeric id from @userinfobot and set AUTHORIZED_TELEGRAM_USER_ID',
    };
  }
  return {
    name: 'Authorized users',
    status: config.telegram.authorizedUserIds.length === 1 ? 'pass' : 'warn',
    detail: `${config.telegram.authorizedUserIds.length} authorized id(s)`,
    hint: config.telegram.authorizedUserIds.length > 1 ? 'This is a single-user system; extra ids widen your attack surface.' : undefined,
  };
}

function checkCopilotAuth(info: CopilotInfo): CheckResult {
  if (!info.authenticatedUser) {
    return {
      name: 'Copilot authentication',
      status: 'fail',
      detail: 'No signed-in Copilot account found',
      hint: 'Run: copilot login',
    };
  }
  return { name: 'Copilot authentication', status: 'pass', detail: `signed in as ${info.authenticatedUser}` };
}

function checkModel(config: AppConfig, info: CopilotInfo): CheckResult {
  if (info.models.length === 0) {
    return {
      name: 'Model availability',
      status: 'warn',
      detail: 'Could not read the CLI model catalogue',
      hint: 'The configured model will be passed through unchecked.',
    };
  }
  const selection = selectModel(config.copilot.model, config.copilot.modelFallback, info.models);
  if (selection.available) {
    return { name: 'Model availability', status: 'pass', detail: `${selection.model} is available` };
  }
  return {
    name: 'Model availability',
    status: selection.fellBack ? 'warn' : 'fail',
    detail: selection.note ?? 'model unavailable',
    hint: `Supported by this CLI build: ${info.models.join(', ')}`,
  };
}

/** Bare-pid or JSON lock file written by acquireLock. */
function lockFilePid(file: string): number | null {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
    const parsed = JSON.parse(raw) as { pid?: number };
    return typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

/**
 * Cross-checks the scheduled task against the live agent. Every silent failure
 * mode observed in production — task missing, watchdog trigger missing, agent
 * orphaned from its task instance, agent dead — surfaces here as one line.
 */
async function checkStartupChain(config: AppConfig): Promise<CheckResult> {
  const name = 'Auto-start task';
  if (!startupSupported()) return { name, status: 'skip', detail: 'only supported on Windows' };

  const pid = lockFilePid(path.join(config.storage.workspace, 'agent.pid'));
  const agentAlive = pid !== null && isProcessAlive(pid);
  let facts;
  try {
    facts = await queryTask();
  } catch (err) {
    return { name, status: 'warn', detail: errorMessage(err) };
  }
  if (!facts) {
    return {
      name,
      status: 'warn',
      detail: agentAlive ? `agent running (pid ${pid}) but no auto-start is installed` : 'not installed — the agent will not survive a reboot',
      hint: 'Run: npm run agent -- startup install',
    };
  }
  if ((facts.triggerCount ?? 0) < 2) {
    return {
      name,
      status: 'warn',
      detail: `task "${STARTUP_TASK_NAME}" has ${facts.triggerCount ?? '?'} trigger(s) — the 5-minute watchdog is missing`,
      hint: 'Re-run: npm run agent -- startup install',
    };
  }
  if (agentAlive && facts.state !== 'Running') {
    return {
      name,
      status: 'warn',
      detail: `agent runs (pid ${pid}) but unsupervised — task state is ${facts.state}`,
      hint: 'Self-corrects: the next watchdog tick (≤5 min) starts a standby that adopts it.',
    };
  }
  if (!agentAlive && facts.state !== 'Running') {
    const lastResult = facts.lastTaskResult === null ? '' : `, last result 0x${facts.lastTaskResult.toString(16).toUpperCase()}`;
    return {
      name,
      status: 'warn',
      detail: `agent is not running (task state ${facts.state}${lastResult})`,
      hint: 'The watchdog starts it within 5 minutes; or: Start-ScheduledTask -TaskName ' + STARTUP_TASK_NAME,
    };
  }
  return {
    name,
    status: 'pass',
    detail: `state ${facts.state}, logon + watchdog triggers${agentAlive ? `, agent pid ${pid}` : ' (instance starting or standby)'}`,
  };
}

/** Remote tasks stall while the PC sleeps; make that a choice, not a surprise. */
async function checkSleepSettings(): Promise<CheckResult> {
  const name = 'Sleep settings';
  if (process.platform !== 'win32') return { name, status: 'skip', detail: 'only checked on Windows' };
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'powercfg.exe');
  const result = await execCommand(exe, ['/q', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE'], {
    cwd: process.cwd(),
    timeoutMs: 15_000,
    shell: false,
  });
  // Localised Windows builds label the line differently; skip rather than guess.
  const match = result.stdout.match(/AC Power Setting Index:\s*0x([0-9a-f]+)/i);
  if (result.code !== 0 || !match) return { name, status: 'skip', detail: 'could not read power settings' };
  const seconds = Number.parseInt(match[1]!, 16);
  if (seconds === 0) return { name, status: 'pass', detail: 'PC does not sleep on AC power' };
  return {
    name,
    status: 'warn',
    detail: `PC sleeps after ${Math.round(seconds / 60)} min on AC — tasks sent from your phone stall until it wakes`,
    hint: 'powercfg /change standby-timeout-ac 0',
  };
}

function checkFilesystem(config: AppConfig): CheckResult {
  try {
    const probe = path.join(config.storage.workspace, '.write-probe');
    fs.mkdirSync(config.storage.workspace, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    return { name: 'Filesystem permissions', status: 'pass', detail: `writable: ${config.storage.workspace}` };
  } catch (err) {
    return { name: 'Filesystem permissions', status: 'fail', detail: errorMessage(err) };
  }
}

function checkDatabase(config: AppConfig): CheckResult {
  try {
    const db = openDatabase(config.storage.databaseFile);
    db.close();
    return { name: 'Task database', status: 'pass', detail: config.storage.databaseFile };
  } catch (err) {
    return { name: 'Task database', status: 'fail', detail: errorMessage(err) };
  }
}

function checkWebHost(config: AppConfig): CheckResult {
  const name = 'Web interface';
  if (!config.interfaces.web) return { name, status: 'skip', detail: 'disabled (WEB_ENABLED is not true)' };
  const host = config.web.host.toLowerCase();
  const where = `${config.web.host}:${config.web.port}`;
  if (host === '0.0.0.0' || host === '::' || host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return { name, status: 'pass', detail: `binds ${where}` };
  }
  const assigned = Object.values(os.networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .some((iface) => iface.address.toLowerCase() === host);
  if (assigned) return { name, status: 'pass', detail: `binds ${where} (address is assigned to this PC)` };
  return {
    name,
    status: 'warn',
    detail: `${config.web.host} is not an address of this PC right now`,
    hint: 'A VPN address (Tailscale) appears once its adapter is up — the agent retries the bind until then. A typo here would make it wait forever.',
  };
}

async function checkProjects(config: AppConfig): Promise<CheckResult[]> {
  const registry = new ProjectRegistry(config.storage.projectsFile);
  try {
    registry.load();
  } catch (err) {
    return [{ name: 'Project registry', status: 'fail', detail: errorMessage(err) }];
  }

  const projects = registry.all();
  if (projects.length === 0) {
    return [
      {
        name: 'Project registry',
        status: 'warn',
        detail: 'No projects registered',
        hint: 'remote-agent projects add <name> <absolute path>',
      },
    ];
  }

  const results: CheckResult[] = [
    { name: 'Project registry', status: 'pass', detail: `${projects.length} project(s) in ${config.storage.projectsFile}` },
  ];

  for (const project of projects) {
    if (!fs.existsSync(project.path)) {
      results.push({ name: `Project: ${project.name}`, status: 'fail', detail: `missing path ${project.path}` });
      continue;
    }
    const git = new Git(project.path);
    const isRepo = await git.isRepository();
    const status = isRepo ? await git.status() : null;
    const commands = detectCommands(project.path, {
      testCommand: project.testCommand,
      buildCommand: project.buildCommand,
    });

    const bits = [
      isRepo ? `git: ${status?.branch ?? 'detached'}${status?.clean ? ' (clean)' : ' (uncommitted changes)'}` : 'not a git repository',
      commands.length > 0 ? commands.map((c) => `${c.kind}: ${c.display}`).join(', ') : 'no test/build command detected',
    ];
    results.push({
      name: `Project: ${project.name}`,
      status: isRepo ? 'pass' : 'warn',
      detail: bits.join(' · '),
      hint: isRepo ? undefined : 'Git safety features (checkpoint, diff, commit) are unavailable outside a repository.',
    });
  }
  return results;
}

export interface DoctorReport {
  results: CheckResult[];
  copilot: CopilotInfo | null;
  ok: boolean;
}

export async function runDoctor(): Promise<DoctorReport> {
  const results: CheckResult[] = [];

  results.push({
    name: 'Operating system',
    status: 'pass',
    detail: `${os.type()} ${os.release()} (${process.arch})`,
  });
  results.push({
    name: 'Node.js',
    status: Number.parseInt(process.versions.node, 10) >= 22 ? 'pass' : 'fail',
    detail: `v${process.versions.node}`,
    hint: 'Node 22.5+ is required for the built-in node:sqlite module.',
  });

  const gitVersion = await which('git');
  results.push(
    gitVersion
      ? { name: 'Git', status: 'pass', detail: gitVersion }
      : { name: 'Git', status: 'fail', detail: 'git not found on PATH' },
  );

  let config: AppConfig | null = null;
  try {
    config = bootstrapConfig({ requireTelegram: false });
    results.push({ name: 'Configuration', status: 'pass', detail: fs.existsSync(path.join(PROJECT_ROOT, '.env')) ? '.env loaded' : 'using defaults (no .env found)' });
  } catch (err) {
    results.push({
      name: 'Configuration',
      status: 'fail',
      detail: err instanceof ConfigError ? err.message : errorMessage(err),
      hint: 'Copy .env.example to .env and fill it in.',
    });
  }

  const copilot = await detectCopilot(config?.copilot.bin ?? null);

  // Report the selected provider, its capability gaps and how it is billed.
  // "Zero additional cost" is only true for Copilot, so the operator must see
  // which CLI they have chosen before it starts spending.
  if (config) {
    const provider = selectProvider(config.provider);
    const gaps = missingCapabilities(provider);
    results.push(
      gaps.length === 0
        ? { name: 'Agent provider', status: 'pass', detail: `${provider.displayName} — billed to ${provider.billing}` }
        : {
            name: 'Agent provider',
            status: 'fail',
            detail: `${provider.displayName} cannot enforce:\n${describeCapabilityGaps(gaps)}`,
            hint: 'Choose a provider that supports the full safety model.',
          },
    );

    if (!provider.capabilities.allowUrlsByDomain) {
      results.push({
        name: 'Network restriction',
        status: 'warn',
        detail: `${provider.displayName} cannot allow-list URLs by domain; network tools are denied wholesale instead`,
      });
    }

    if (config.provider !== 'copilot') {
      const info = await provider.detect(null);
      results.push(
        info.installed
          ? { name: `${provider.displayName} CLI`, status: 'pass', detail: info.version ?? 'installed' }
          : {
              name: `${provider.displayName} CLI`,
              status: 'fail',
              detail: info.error ?? 'not found',
            },
      );
      if (info.launcher && !info.launcher.safe) {
        results.push({
          name: `${provider.displayName} launch safety`,
          status: 'fail',
          detail: 'Resolved to a shell shim; prompt text would pass through a shell',
        });
      }
    }
  }

  results.push(
    copilot.installed
      ? { name: 'Copilot CLI', status: 'pass', detail: `v${copilot.version} · ${copilot.launcher?.description ?? ''}` }
      : {
          name: 'Copilot CLI',
          status: 'fail',
          detail: copilot.error ?? 'not found',
          hint: 'npm install -g @github/copilot',
        },
  );
  if (copilot.launcher && !copilot.launcher.safe) {
    results.push({
      name: 'Copilot launch safety',
      status: 'fail',
      detail: 'Resolved to a shell shim; prompt text would pass through a shell',
      hint: 'Set COPILOT_BIN to <npm root -g>/@github/copilot/npm-loader.js',
    });
  }
  results.push(checkCopilotAuth(copilot));

  if (config) {
    results.push(
      config.copilot.sandbox
        ? {
            name: 'Shell containment',
            status: 'pass',
            detail: 'COPILOT_SANDBOX=true — shell commands run in the CLI\u2019s OS sandbox',
          }
        : {
            name: 'Shell containment',
            status: 'warn',
            detail: 'Sandbox off — shell commands run with your full user rights',
            hint: 'The deny-list is defence in depth, not a boundary. Set COPILOT_SANDBOX=true for real containment (experimental; may break some builds).',
          },
    );
  }

  if (config?.copilot.agent === AGENT_NAME) {
    results.push(
      isAgentInstalled()
        ? { name: 'Custom Copilot agent', status: 'pass', detail: agentTargetPath() }
        : {
            name: 'Custom Copilot agent',
            status: 'warn',
            detail: `"${AGENT_NAME}" is configured but not installed`,
            hint: 'Run: remote-agent install-agent   (the agent is installed automatically on start)',
          },
    );
  }

  if (config) {
    results.push(checkModel(config, copilot));
    results.push(checkAuthorizedUsers(config));
    results.push(await checkTelegram(config));
    results.push(checkFilesystem(config));
    results.push(checkDatabase(config));
    results.push(checkWebHost(config));
    results.push(await checkStartupChain(config));
    results.push(...(await checkProjects(config)));
  }

  results.push(await checkSleepSettings());
  results.push(await checkInternet());

  return { results, copilot, ok: results.every((r) => r.status !== 'fail') };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ['', 'Remote Personal Coding Agent — diagnostics', '='.repeat(52), ''];
  for (const result of report.results) {
    lines.push(`[${ICON[result.status]}] ${result.name.padEnd(26)} ${result.detail}`);
    if (result.hint) lines.push(`      ↳ ${result.hint}`);
  }
  lines.push('', report.ok ? '✔ All required checks passed.' : '✖ One or more required checks failed (see above).', '');
  lines.push('Cost: this application adds no recurring charges. Telegram Bot API, SQLite and');
  lines.push('long polling are free; AI usage is billed against your existing Copilot plan.');
  lines.push('');
  return lines.join('\n');
}