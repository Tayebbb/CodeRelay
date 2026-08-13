import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapConfig, ConfigError } from './core/config.js';
import { configureLogger, createLogger, errorMessage } from './core/logger.js';
import { openDatabase } from './db/database.js';
import { TaskRepository } from './db/taskRepository.js';
import { ProjectRegistry } from './projects/registry.js';
import { detectCopilot, selectModel } from './copilot/detect.js';
import { AGENT_NAME, installAgent } from './copilot/agentInstall.js';
import { ApprovalService } from './approval/service.js';
import { TaskRunner } from './runner/taskRunner.js';
import { TaskQueue } from './runner/queue.js';
import { TelegramBot } from './telegram/bot.js';
import { nullNotifier, type Notifier } from './notify/notifier.js';

const log = createLogger('main');

export async function main(): Promise<number> {
  let config;
  try {
    config = bootstrapConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\nConfiguration error: ${err.message}\n`);
      console.error('Run `remote-agent doctor` for a full diagnostic.\n');
      return 2;
    }
    throw err;
  }

  configureLogger({ level: config.logLevel, directory: config.storage.logDirectory });
  log.info('Starting remote coding agent', { workspace: config.storage.workspace });

  const copilot = await detectCopilot(config.copilot.bin);
  if (!copilot.installed || !copilot.launcher) {
    console.error(`\nCopilot CLI unavailable: ${copilot.error}\n`);
    console.error('Install it with:  npm install -g @github/copilot\n');
    return 3;
  }
  if (!copilot.authenticatedUser) {
    console.error('\nCopilot CLI is installed but no account is signed in. Run: copilot login\n');
    return 4;
  }

  const selection = selectModel(config.copilot.model, config.copilot.modelFallback, copilot.models);
  if (selection.note) log.warn(selection.note);

  // The CLI resolves custom agents relative to the working directory, which is
  // the target project. Installing at the user level covers every project
  // without modifying any of them.
  if (config.copilot.agent === AGENT_NAME) {
    const install = installAgent();
    if (!install.installed) {
      log.warn('Custom agent could not be installed; continuing without it', { error: install.error });
      config.copilot.agent = null;
    } else if (install.changed) {
      log.info('Installed custom Copilot agent', { target: install.target });
    }
  }

  const pidFile = path.join(config.storage.workspace, 'agent.pid');
  const existing = readPidFile(pidFile);
  if (existing !== null && isProcessAlive(existing)) {
    console.error(`\nAnother agent instance is already running (pid ${existing}).\n`);
    return 5;
  }
  fs.writeFileSync(pidFile, String(process.pid), 'utf8');

  const db = openDatabase(config.storage.databaseFile);
  const tasks = new TaskRepository(db);
  tasks.pruneProcessedUpdates();

  const projects = new ProjectRegistry(config.storage.projectsFile);
  projects.load();
  log.info('Project registry loaded', { count: projects.enabled().length });

  // The bot is the Notifier, but the ApprovalService and TaskRunner are created
  // first. A tiny forwarding shim breaks the cycle.
  let notifierTarget: Notifier = nullNotifier;
  const notifier: Notifier = {
    sendMessage: (chatId, text) => notifierTarget.sendMessage(chatId, text),
    requestApproval: (request) => notifierTarget.requestApproval(request),
  };

  const approvals = new ApprovalService(tasks, notifier, config.limits.approvalTimeoutMs);
  const runner = new TaskRunner({ config, tasks, projects, notifier, approvals, copilot });
  const queue = new TaskQueue(tasks, runner, { maxConcurrent: config.limits.maxConcurrentTasks });

  const bot = new TelegramBot({
    config,
    tasks,
    projects,
    queue,
    runner,
    approvals,
    copilot,
    startedAt: Date.now(),
  });
  notifierTarget = bot;

  queue.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down', { signal });
    approvals.cancelAll();
    await queue.stop();
    await bot.stop().catch(() => {});
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(pidFile, { force: true });
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', { error: errorMessage(reason) }));
  process.on('uncaughtException', (err) => log.error('Uncaught exception', { error: errorMessage(err) }));

  const recovered = tasks.listByStatus('QUEUED');
  await bot.notifyOperators(
    [
      '🟢 Home PC agent is online',
      '',
      `Copilot CLI: v${copilot.version} (${copilot.authenticatedUser})`,
      `Model: ${selection.model}${selection.fellBack ? ` (fallback from ${selection.requested})` : ''}`,
      `Projects: ${projects.enabled().length}`,
      recovered.length > 0 ? `Recovered ${recovered.length} queued task(s).` : '',
      selection.note ? `\n⚠️ ${selection.note}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  ).catch(() => {});

  await bot.start();
  return 0;
}

export function readPidFile(file: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((err) => {
      console.error(errorMessage(err));
      process.exit(1);
    });
}
