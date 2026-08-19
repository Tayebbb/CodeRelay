import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapConfig, ConfigError } from './core/config.js';
import { configureLogger, createLogger, errorMessage } from './core/logger.js';
import { openDatabaseResilient } from './db/database.js';
import { TaskRepository } from './db/taskRepository.js';
import { ProjectRegistry } from './projects/registry.js';
import { detectCopilot, selectModel } from './copilot/detect.js';
import { PROVIDER_IDS, selectProvider, type ProviderId, type ProviderInfo } from './providers/index.js';
import { AGENT_NAME, installAgent } from './copilot/agentInstall.js';
import { ApprovalService } from './approval/service.js';
import { TaskRunner } from './runner/taskRunner.js';
import { TaskQueue } from './runner/queue.js';
import { TelegramBot } from './telegram/bot.js';
import { fanOutNotifier, nullNotifier, type Notifier } from './notify/notifier.js';
import { EventBus } from './core/events.js';
import { TaskService } from './core/taskService.js';
import { GitControlService } from './core/gitControl.js';
import { WebServer, webNotifier } from './web/server.js';
import { passwordFileExists } from './web/auth.js';
import { acquireLock, isProcessAlive } from './core/lock.js';
import { isTerminal } from './domain/task.js';
import { Git } from './git/git.js';

const log = createLogger('main');

const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECKPOINT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Send a message to the operator without a grammY bot instance.
 *
 * Used only on the startup paths that fail before the bot exists. A plain HTTPS
 * call keeps it dependency-free and, more importantly, keeps working when the
 * reason we are aborting is that the bot could not be constructed.
 */
async function notifyOperatorsDirect(
  config: { telegram: { botToken: string; authorizedUserIds: number[] } },
  text: string,
): Promise<void> {
  const { botToken, authorizedUserIds } = config.telegram;
  if (!botToken || authorizedUserIds.length === 0) return;

  for (const chatId of authorizedUserIds) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3500) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) log.warn('Startup notification rejected by Telegram', { status: response.status });
    } catch (err) {
      // Best effort: if the network is down there is nothing else we can do.
      log.warn('Could not send startup notification', { error: errorMessage(err) });
    }
  }
}

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

  // With no interface there is no way to command or observe the agent — that
  // is a misconfiguration, not a valid headless mode.
  if (!config.interfaces.telegram && !config.interfaces.web) {
    console.error(
      '\nNo interface is enabled. Set TELEGRAM_ENABLED=true (with bot credentials), WEB_ENABLED=true, or both.\n',
    );
    return 2;
  }
  if (config.interfaces.web && !passwordFileExists(config.web.authFile)) {
    console.error('\nThe web interface is enabled but has no password yet.\nCreate one with:  npm run agent -- web setup\n');
    return 2;
  }

  /**
   * Tell the operator why we are refusing to start, THEN exit.
   *
   * Everything below this point can fail before the bot exists, and the startup
   * task restarts the process every minute. Without this the most likely real
   * failure — an expired `copilot login` — is a silent hourly restart loop that
   * the owner, who is far from the machine, never hears about.
   */
  const abort = async (code: number, message: string): Promise<number> => {
    console.error(`\n${message}\n`);
    log.error('Refusing to start', { code, message });
    await notifyOperatorsDirect(config, `🚫 The coding agent could not start.\n\n${message}`);
    return code;
  };

  const copilot = await detectCopilot(config.copilot.bin);

  // Every known provider is probed once so tasks can choose among the installed
  // ones. Only the DEFAULT provider is required to be usable at startup.
  const providers: Partial<Record<ProviderId, ProviderInfo>> = {
    copilot: {
      id: 'copilot',
      installed: copilot.installed,
      version: copilot.version,
      launcher: copilot.launcher,
      models: copilot.models,
      authenticatedUser: copilot.authenticatedUser,
      error: copilot.error ?? null,
    },
  };
  for (const id of PROVIDER_IDS) {
    if (id === 'copilot') continue;
    try {
      providers[id] = await selectProvider(id).detect(null);
    } catch (err) {
      log.warn(`Could not probe provider "${id}"`, { error: errorMessage(err) });
    }
  }

  if (config.provider === 'copilot') {
    if (!copilot.installed || !copilot.launcher) {
      return await abort(3, `Copilot CLI unavailable: ${copilot.error}\nInstall it with:  npm install -g @github/copilot`);
    }
    if (!copilot.authenticatedUser) {
      return await abort(4, 'Copilot CLI is installed but no account is signed in.\nRun on the PC:  copilot login');
    }
  } else {
    const info = providers[config.provider];
    if (!info?.installed || !info.launcher) {
      return await abort(3, `The configured agent provider "${config.provider}" is not usable: ${info?.error ?? 'not installed'}`);
    }
  }

  // The banner's model line reflects the DEFAULT provider's catalogue; another
  // provider's default is its first listed model.
  const activeInfo = providers[config.provider]!;
  const bannerDefaultModel =
    config.provider === 'copilot' || activeInfo.models.includes(config.copilot.model)
      ? config.copilot.model
      : activeInfo.models[0] ?? config.copilot.model;
  const selection = selectModel(bannerDefaultModel, config.copilot.modelFallback, activeInfo.models);
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
  const lock = acquireLock(pidFile);
  if (!lock.acquired) {
    // Deliberately NOT reported to Telegram: the instance already running is
    // the one that will answer, and a message per restart attempt is noise.
    // It must reach the log file though — under the scheduled task there is
    // no console for anyone to read.
    console.error(`\nAnother agent instance is already running (pid ${lock.heldBy?.pid}).\n`);
    log.error('Refusing to start: another instance holds the lock', { pid: lock.heldBy?.pid ?? null });
    return 5;
  }

  let db;
  let quarantined: string | null = null;
  try {
    const opened = openDatabaseResilient(config.storage.databaseFile);
    db = opened.db;
    quarantined = opened.quarantined;
    if (quarantined) {
      log.error('Task database was corrupt and has been moved aside; starting with a fresh one', { quarantined });
    }
  } catch (err) {
    lock.release();
    return await abort(
      6,
      `Could not open the task database (${config.storage.databaseFile}): ${errorMessage(err)}`,
    );
  }

  const bus = new EventBus();
  const tasks = new TaskRepository(db, bus);
  tasks.pruneHistory();

  const projects = new ProjectRegistry(config.storage.projectsFile);
  projects.load();
  log.info('Project registry loaded', { count: projects.enabled().length });

  const retentionTimer = setInterval(() => {
    void (async () => {
      try {
        tasks.pruneHistory();
        // Checkpoint refs pin whole trees, so they must be swept from the user's
        // repositories too, not just from our own database.
        for (const project of projects.enabled()) {
          const removed = await new Git(project.path).pruneCheckpoints(CHECKPOINT_RETENTION_MS);
          if (removed > 0) log.info('Pruned old checkpoints', { project: project.id, removed });
        }
      } catch (err) {
        log.warn('Retention sweep failed', { error: errorMessage(err) });
      }
    })();
  }, RETENTION_INTERVAL_MS);
  retentionTimer.unref?.();

  // The bot is the Notifier, but the ApprovalService and TaskRunner are created
  // first. A tiny forwarding shim breaks the cycle.
  let notifierTarget: Notifier = nullNotifier;
  const notifier: Notifier = {
    sendMessage: (chatId, text) => notifierTarget.sendMessage(chatId, text),
    requestApproval: (request) => notifierTarget.requestApproval(request),
  };

  const approvals = new ApprovalService(tasks, notifier, config.limits.approvalTimeoutMs);
  const runner = new TaskRunner({ config, tasks, projects, notifier, approvals, copilot, providers, bus });
  const queue = new TaskQueue(tasks, runner, { maxConcurrent: config.limits.maxConcurrentTasks });
  const service = new TaskService({ config, tasks, projects, queue, runner, approvals, notifier });
  const gitControl = new GitControlService({ projects, tasks });

  const bot = config.interfaces.telegram
    ? new TelegramBot({
        config,
        tasks,
        projects,
        queue,
        runner,
        approvals,
        service,
        gitControl,
        copilot,
        startedAt: Date.now(),
      })
    : null;

  let web: WebServer | null = null;
  if (config.interfaces.web) {
    web = new WebServer({ config, tasks, projects, queue, approvals, service, gitControl, copilot, providers, bus, startedAt: Date.now() });
  }

  // Approval requests reach every enabled interface; the task proceeds if at
  // least one heard it.
  const targets: Notifier[] = [];
  if (bot) targets.push(bot);
  if (web) targets.push(webNotifier(bus));
  notifierTarget = fanOutNotifier(targets);

  queue.start();

  // Approval waiters live only in memory. A task left in WAITING_APPROVAL by a
  // restart would otherwise never reach a terminal state.
  const stranded = tasks.pendingApprovals();
  for (const task of stranded) {
    try {
      tasks.transition(task.id, 'CANCELLED', {
        error: 'The agent restarted while this task was awaiting approval. Re-send it with /retry.',
        approvalStatus: 'EXPIRED',
      });
      log.warn('Cancelled a task stranded in WAITING_APPROVAL by a restart', { taskId: task.id });
    } catch (err) {
      log.error('Could not clear a stranded approval', { taskId: task.id, error: errorMessage(err) });
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (exitCode !== 0) process.exitCode = exitCode;
    log.info('Shutting down', { signal });
    clearInterval(retentionTimer);

    // Stop polling FIRST: otherwise a task or approval created during the drain
    // below would be missed by cancelAll() and could block shutdown for minutes.
    await bot?.stopAcceptingUpdates().catch(() => {});
    await web?.stop().catch(() => {});
    approvals.cancelAll();

    // Wait for in-flight work so its terminal state is written BEFORE the
    // database closes; otherwise the task is re-queued and re-billed.
    await queue.stop().catch(() => {});

    // Anything that did not unwind within the grace period is marked terminal
    // here rather than left RUNNING for recoverOrphans to re-run and re-bill.
    for (const id of queue.activeIds()) {
      try {
        const task = tasks.get(id);
        if (task && !isTerminal(task.status)) {
          tasks.transition(id, 'CANCELLED', {
            error: 'The agent shut down while this task was running. It was not resumed automatically.',
          });
        }
      } catch (err) {
        log.warn('Could not finalise a task during shutdown', { taskId: id, error: errorMessage(err) });
      }
    }

    await service.drain().catch(() => {});
    try {
      db.close();
    } catch {
      // ignore
    }
    lock.release();
    process.exit(exitCode);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
  // CTRL_CLOSE (console window closed) arrives as SIGHUP with a ~5s budget
  // before Windows force-kills. Without a handler node dies instantly and
  // silently — a whole night of "who killed the agent?" forensics hinged on
  // this line existing. Best-effort cleanup; the first log write is sync.
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
  process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', { error: errorMessage(reason) }));
  process.on('uncaughtException', (err) => {
    // Staying alive after a fatal error produces a wedged agent that looks idle
    // from the phone. Exit non-zero so the supervisor restarts it cleanly.
    log.error('Uncaught exception — exiting so the supervisor can restart', { error: errorMessage(err) });
    process.exitCode = 1;
    void shutdown('uncaughtException', 1);
    // Must outlast the shutdown budget: queue.stop() alone allows 20s, and a
    // Copilot child gets a 10s post-kill grace. Exiting at 5s cut shutdown off
    // before it could write the task's terminal state — so the task was
    // re-queued and RE-BILLED on restart — and left the child process running.
    setTimeout(() => process.exit(1), 35_000).unref?.();
  });

  const recovery = queue.recoveryReport();
  const banner = [
    '🟢 Home PC agent is online',
    '',
    `Agent: ${config.provider === 'copilot' ? 'Copilot CLI' : config.provider} v${activeInfo.version ?? '?'} (${activeInfo.authenticatedUser ?? 'signed in'})`,
    `Model: ${selection.model}${selection.fellBack ? ` (fallback from ${selection.requested})` : ''}`,
    `Projects: ${projects.enabled().length}`,
    `Interfaces: ${[config.interfaces.telegram ? 'Telegram' : null, config.interfaces.web ? 'Web' : null].filter(Boolean).join(' + ')}`,
    `Sandbox: ${config.copilot.sandbox ? 'on (experimental)' : 'off'}`,
    ...recovery.requeued.map(
      (task) =>
        `♻️ Task #${task.id} was interrupted (${task.usage.aiCredits.toFixed(2)} credits spent) and will re-run.\n` +
        `   Snapshot of your work before it started: git checkout refs/remote-agent/checkpoint-${task.id} -- .`,
    ),
    ...recovery.abandoned.map(
      (task) => `⚠️ Task #${task.id} was interrupted too many times and was abandoned. Use /retry to run it again.`,
    ),
    stranded.length > 0 ? `⚠️ ${stranded.length} task(s) awaiting approval were cancelled by the restart.` : '',
    quarantined ? `⚠️ The task database was corrupt and was moved to ${quarantined}. History was lost; projects and code are untouched.` : '',
    projects.loadError() ? `⚠️ Project registry problem: ${projects.loadError()}` : '',
    selection.note ? `\n⚠️ ${selection.note}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  // The web server starts first but must never hold Telegram hostage: a bind
  // the OS cannot satisfy yet (the Tailscale adapter is still starting when
  // the logon task runs) is waited out in the background while the rest of
  // the agent comes up. Only a non-transient bind error is fatal.
  if (web) {
    const webServer = web;
    void webServer
      .start({
        onWaiting: (message) => {
          log.warn(message);
          void notifyOperatorsDirect(config, `⚠️ ${message}`);
        },
        onRecovered: (message) => {
          log.info(message);
          void notifyOperatorsDirect(config, `✅ ${message}`);
        },
      })
      .then((outcome) => {
        if (outcome === 'listening') console.log(`\nWeb interface: ${webServer.address()}\n`);
      })
      .catch(async (err) => {
        // Notify BEFORE shutdown: shutdown() exits the process, so anything
        // sequenced after it never runs. This exact ordering once made bind
        // failures silent — no errno in the log, no message to the operator,
        // just a dead agent until someone restarted it at the PC.
        const message = `The web interface could not start: ${errorMessage(err)}`;
        console.error(`\n${message}\n`);
        log.error('Refusing to run without the web interface', { error: errorMessage(err) });
        await notifyOperatorsDirect(config, `🚫 The coding agent is stopping.\n\n${message}`);
        void shutdown('web-start-failed', 7);
      });
  }

  if (bot) {
    try {
      // Sent after polling starts so it is not lost when the network is not up yet.
      await bot.start({ onReady: () => void bot.notifyOperators(banner).catch(() => {}) });
    } catch (err) {
      // Only fatal Telegram errors surface here (revoked token, another poller);
      // transient trouble is retried inside start() forever. Notify BEFORE
      // shutdown — shutdown() exits the process. Without this catch the
      // rejection reached the entry handler: console-only, no log, no cleanup.
      const message = `The Telegram interface stopped fatally: ${errorMessage(err)}`;
      console.error(`\n${message}\n`);
      log.error('Refusing to run without Telegram', { error: errorMessage(err) });
      await notifyOperatorsDirect(config, `🚫 ${message}`);
      await shutdown('telegram-failed', 8);
    }
  } else {
    log.info('Telegram interface disabled');
    // Without Telegram the process has no grammY loop to hold it open; the web
    // server and queue keep it alive instead.
    await new Promise(() => {});
  }
  return 0;
}

export function readPidFile(file: string): number | null {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
    const parsed = JSON.parse(raw) as { pid?: number };
    return typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

export { isProcessAlive };

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
