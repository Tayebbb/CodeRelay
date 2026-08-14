import fs from 'node:fs';
import path from 'node:path';
import { bootstrapConfig, ConfigError, PROJECT_ROOT } from './core/config.js';
import { configureLogger } from './core/logger.js';
import { openDatabase } from './db/database.js';
import { TaskRepository } from './db/taskRepository.js';
import { ProjectRegistry, ProjectRegistryError } from './projects/registry.js';
import { detectCopilot, selectModel } from './copilot/detect.js';
import { AGENT_NAME, agentTargetPath, installAgent, uninstallAgent } from './copilot/agentInstall.js';
import { detectCommands } from './verify/detector.js';
import { formatDoctorReport, runDoctor } from './health/doctor.js';
import { formatDuration } from './telegram/format.js';
import { isProcessAlive, main, readPidFile } from './main.js';
import { statusEmoji } from './domain/task.js';
import { createPasswordFile, passwordFileExists } from './web/auth.js';
import {
  queryTask,
  runInstall,
  runUninstall,
  startupSupported,
  STARTUP_TASK_NAME,
  validateBuilt,
} from './startup/windows.js';

const USAGE = `
remote-agent — control the home-PC coding agent

  remote-agent start                 Run the agent in the foreground
  remote-agent stop                  Stop a running agent
  remote-agent status                Show agent, queue and usage status
  remote-agent doctor                Full diagnostic report
  remote-agent models                Models supported by the installed Copilot CLI
  remote-agent install-agent         Install the custom Copilot agent for all projects
  remote-agent uninstall-agent       Remove the custom Copilot agent

  remote-agent projects              List registered projects
  remote-agent projects add <name> <path> [--id x] [--test "cmd"] [--build "cmd"]
  remote-agent projects remove <id>
  remote-agent projects check <id>   Inspect a project (git state, detected commands)

  remote-agent tasks [n]             Recent tasks
  remote-agent logs <id>             Event log for a task
  remote-agent test                  Self-test: config, db, registry, detection (no AI calls)

  remote-agent startup install       Start automatically at Windows logon (+ crash restart)
  remote-agent startup status        Auto-start and agent process status
  remote-agent startup remove        Remove auto-start (keeps all data and config)

  remote-agent web setup             Create (or replace) the web interface password
`;

function config(requireTelegram = false) {
  const cfg = bootstrapConfig({ requireTelegram });
  configureLogger({ level: cfg.logLevel, directory: cfg.storage.logDirectory });
  return cfg;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function cmdStatus(): Promise<number> {
  const cfg = config();
  const pidFile = path.join(cfg.storage.workspace, 'agent.pid');
  const pid = readPidFile(pidFile);
  const alive = pid !== null && isProcessAlive(pid);

  const db = openDatabase(cfg.storage.databaseFile);
  const tasks = new TaskRepository(db);
  const copilot = await detectCopilot(cfg.copilot.bin);
  const selection = selectModel(cfg.copilot.model, cfg.copilot.modelFallback, copilot.models);

  const running = tasks.listByStatus('RUNNING').length + tasks.listByStatus('TESTING').length;
  const queued = tasks.listByStatus('QUEUED').length;
  const waiting = tasks.listByStatus('WAITING_APPROVAL').length;

  console.log(
    [
      '',
      `Agent:        ${alive ? `RUNNING (pid ${pid})` : 'STOPPED'}`,
      `Workspace:    ${cfg.storage.workspace}`,
      `Copilot CLI:  ${copilot.installed ? `v${copilot.version}` : 'not installed'}`,
      `Account:      ${copilot.authenticatedUser ?? 'not signed in'}`,
      `Model:        ${selection.model}${selection.fellBack ? ` (fallback from ${selection.requested})` : ''}`,
      '',
      `Running:      ${running}`,
      `Queued:       ${queued}`,
      `Approval:     ${waiting}`,
      '',
      `AI credits 24h: ${tasks.creditsUsedSince(24 * 60 * 60 * 1000).toFixed(2)}` +
        (cfg.limits.maxAiCreditsPerDay > 0 ? ` / ${cfg.limits.maxAiCreditsPerDay}` : ''),
      '',
    ].join('\n'),
  );
  db.close();
  return 0;
}

async function cmdStop(): Promise<number> {
  const cfg = config();
  const pidFile = path.join(cfg.storage.workspace, 'agent.pid');
  const pid = readPidFile(pidFile);
  if (pid === null || !isProcessAlive(pid)) {
    console.log('Agent is not running.');
    fs.rmSync(pidFile, { force: true });
    return 0;
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to pid ${pid}.`);
    return 0;
  } catch (err) {
    console.error(`Could not stop pid ${pid}: ${(err as Error).message}`);
    return 1;
  }
}

function cmdProjects(args: string[]): number {
  const cfg = config();
  const registry = new ProjectRegistry(cfg.storage.projectsFile);
  registry.load();
  const [sub, ...rest] = args;

  if (!sub || sub === 'list') {
    const projects = registry.all();
    if (projects.length === 0) {
      console.log(`\nNo projects registered in ${cfg.storage.projectsFile}\n`);
      console.log('Add one with:  remote-agent projects add MediLink "C:\\\\Users\\\\Me\\\\Projects\\\\MediLink"\n');
      return 0;
    }
    console.log('');
    projects.forEach((project, index) => {
      console.log(`${index + 1}. ${project.name}  (id: ${project.id})${project.enabled === false ? '  [disabled]' : ''}`);
      console.log(`   ${project.path}`);
      if (project.testCommand) console.log(`   test:  ${project.testCommand}`);
      if (project.buildCommand) console.log(`   build: ${project.buildCommand}`);
    });
    console.log('');
    return 0;
  }

  if (sub === 'add') {
    const [name, projectPath] = rest;
    if (!name || !projectPath) {
      console.error('Usage: remote-agent projects add <name> <absolute path> [--id x] [--test "cmd"] [--build "cmd"]');
      return 1;
    }
    try {
      const record = registry.add({
        id: flag(rest, 'id') ?? name,
        name,
        path: path.resolve(projectPath),
        description: flag(rest, 'description'),
        testCommand: flag(rest, 'test'),
        buildCommand: flag(rest, 'build'),
      });
      console.log(`Registered "${record.name}" (id: ${record.id}) -> ${record.path}`);
      return 0;
    } catch (err) {
      console.error(err instanceof ProjectRegistryError ? err.message : String(err));
      return 1;
    }
  }

  if (sub === 'remove') {
    const [id] = rest;
    if (!id) {
      console.error('Usage: remote-agent projects remove <id>');
      return 1;
    }
    console.log(registry.remove(id) ? `Removed "${id}".` : `No project with id "${id}".`);
    return 0;
  }

  if (sub === 'check') {
    const [id] = rest;
    const project = id ? registry.getById(id) : null;
    if (!project) {
      console.error(`No project with id "${id}".`);
      return 1;
    }
    const commands = detectCommands(project.path, {
      testCommand: project.testCommand,
      buildCommand: project.buildCommand,
    });
    console.log(`\n${project.name}\n  path: ${project.path}`);
    console.log(`  git:  ${fs.existsSync(path.join(project.path, '.git')) ? 'yes' : 'no'}`);
    if (commands.length === 0) console.log('  no test/build command detected');
    for (const command of commands) console.log(`  ${command.kind}: ${command.display}   (${command.source})`);
    console.log('');
    return 0;
  }

  console.error(USAGE);
  return 1;
}

function cmdTasks(args: string[]): number {
  const cfg = config();
  const db = openDatabase(cfg.storage.databaseFile);
  const tasks = new TaskRepository(db);
  const registry = new ProjectRegistry(cfg.storage.projectsFile);
  registry.load();

  const limit = Math.min(Math.max(Number.parseInt(args[0] ?? '15', 10) || 15, 1), 100);
  const list = tasks.list(limit);
  if (list.length === 0) {
    console.log('No tasks yet.');
  } else {
    console.log('');
    for (const task of list) {
      const project = registry.getById(task.projectId);
      const duration =
        task.startedAt && task.completedAt ? ` ${formatDuration(task.completedAt - task.startedAt)}` : '';
      console.log(
        `${statusEmoji(task.status)} #${String(task.id).padEnd(4)} ${task.status.padEnd(16)} ${(project?.name ?? task.projectId).padEnd(14)} ${task.prompt.split('\n')[0]?.slice(0, 60)}${duration}`,
      );
    }
    console.log('');
  }
  db.close();
  return 0;
}

function cmdLogs(args: string[]): number {
  const id = Number.parseInt(args[0] ?? '', 10);
  if (Number.isNaN(id)) {
    console.error('Usage: remote-agent logs <task id>');
    return 1;
  }
  const cfg = config();
  const db = openDatabase(cfg.storage.databaseFile);
  const tasks = new TaskRepository(db);
  const task = tasks.get(id);
  if (!task) {
    console.error(`Task #${id} not found.`);
    db.close();
    return 1;
  }

  console.log(`\nTask #${task.id}  [${task.status}]  project=${task.projectId}`);
  console.log(`Prompt: ${task.prompt}\n`);
  for (const event of tasks.events(id, 500)) {
    console.log(`${new Date(event.ts).toISOString()}  ${event.kind.padEnd(10)} ${event.message}`);
  }
  if (task.result) {
    console.log('\nFiles changed:');
    for (const file of task.result.filesChanged) console.log(`  - ${file}`);
    for (const verification of task.result.verifications) {
      console.log(`\n${verification.kind}: ${verification.passed ? 'passed' : 'FAILED'} (${verification.command})`);
      if (!verification.passed) console.log(verification.summary);
    }
  }
  if (task.error) console.log(`\nError:\n${task.error}`);
  console.log('');
  db.close();
  return 0;
}

async function cmdModels(): Promise<number> {
  const cfg = config();
  const copilot = await detectCopilot(cfg.copilot.bin);
  if (!copilot.installed) {
    console.error(copilot.error ?? 'Copilot CLI not found.');
    return 1;
  }
  console.log(`\nCopilot CLI v${copilot.version} supports:\n`);
  for (const model of copilot.models) {
    console.log(`  ${model}${model === cfg.copilot.model ? '   <- configured' : ''}`);
  }
  if (!copilot.models.includes(cfg.copilot.model)) {
    console.log(`\n⚠️  Configured COPILOT_MODEL="${cfg.copilot.model}" is NOT in this list.`);
    console.log(`   Fallback: ${cfg.copilot.modelFallback ?? '(none — tasks will refuse to run)'}`);
  }
  console.log('');
  return 0;
}

async function cmdSelfTest(): Promise<number> {
  console.log('\nSelf-test (no Copilot AI calls are made)\n');
  let failures = 0;
  const check = (name: string, ok: boolean, detail = '') => {
    console.log(`  [${ok ? '✔' : '✖'}] ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  try {
    const cfg = config();
    check('configuration loads', true, cfg.storage.workspace);

    const db = openDatabase(':memory:');
    const tasks = new TaskRepository(db);
    const task = tasks.create({
      userId: 1,
      chatId: 1,
      projectId: 'selftest',
      prompt: 'self test',
      approvalRequired: false,
      approvalReason: null,
    });
    check('database create/read', tasks.get(task.id)?.prompt === 'self test');
    tasks.transition(task.id, 'RUNNING');
    tasks.transition(task.id, 'COMPLETED', { result: null });
    check('state machine transitions', tasks.get(task.id)?.status === 'COMPLETED');
    db.close();

    const registry = new ProjectRegistry(cfg.storage.projectsFile);
    registry.load();
    check('project registry loads', true, `${registry.all().length} project(s)`);

    const commands = detectCommands(PROJECT_ROOT);
    check('command detection', commands.length > 0, commands.map((c) => c.display).join(', ') || 'none found');

    const copilot = await detectCopilot(cfg.copilot.bin);
    check('copilot cli detected', copilot.installed, copilot.version ?? copilot.error ?? '');
    check('copilot launch is shell-free', copilot.launcher?.safe === true, copilot.launcher?.description ?? '');
  } catch (err) {
    check('self-test completed', false, err instanceof ConfigError ? err.message : String(err));
  }

  console.log(`\n${failures === 0 ? 'All self-tests passed.' : `${failures} self-test(s) failed.`}\n`);
  return failures === 0 ? 0 : 1;
}

/** Read a line from the terminal, echoing `*` per key (or plaintext with 'plain'). */
function readHidden(promptText: string, echo: 'mask' | 'plain' = 'mask'): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(promptText);
    const stdin = process.stdin;
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    let value = '';
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          stdin.off('data', onData);
          if (stdin.isTTY) stdin.setRawMode(wasRaw);
          stdin.pause();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          // Ctrl+C
          process.stdout.write('\n');
          process.exit(130);
        }
        if (char === '\u0008' || char === '\u007f') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        value += char;
        process.stdout.write(echo === 'plain' ? char : '*');
      }
    };
    stdin.on('data', onData);
  });
}

async function cmdWeb(args: string[]): Promise<number> {
  if (args[0] !== 'setup') {
    console.error('Usage: remote-agent web setup [--show]');
    return 1;
  }
  const cfg = config(false);
  if (passwordFileExists(cfg.web.authFile)) {
    console.log('A web password already exists. Continuing will REPLACE it and sign out every session.');
  }

  // --show echoes the password in plaintext for people who type blind badly;
  // it stays on their own screen and is never logged.
  const echo = args.includes('--show') ? ('plain' as const) : ('mask' as const);
  const password = await readHidden('New web password (min 8 characters): ', echo);
  if (password.length < 8) {
    console.error('Too short. The password must be at least 8 characters.');
    return 1;
  }
  const confirmed = await readHidden('Repeat it: ', echo);
  if (password !== confirmed) {
    console.error('The passwords do not match. Nothing was changed.');
    return 1;
  }

  createPasswordFile(cfg.web.authFile, password);
  console.log(`\nWeb password saved to ${cfg.web.authFile}`);
  console.log('Enable the interface with WEB_ENABLED=true in .env, then start the agent.');
  return 0;
}

async function cmdStartup(args: string[]): Promise<number> {
  const [sub] = args;
  if (!startupSupported()) {
    console.error('Auto-start management is Windows-only (per-user Scheduled Task). On other systems use your init system.');
    return 1;
  }

  switch (sub) {
    case 'install': {
      const buildProblem = validateBuilt();
      if (buildProblem) {
        console.error(buildProblem);
        return 1;
      }
      // Prove the agent can actually start before wiring it to logon: a broken
      // .env would otherwise become a restart loop the operator never sees.
      config();

      const result = await runInstall(process.execPath);
      if (!result.ok) {
        console.error(`Could not install the startup task:\n${result.output}`);
        return 1;
      }
      const facts = await queryTask();
      console.log(
        [
          '',
          '✓ CodeRelay startup installed',
          '',
          `  Method:          Windows Scheduled Task "${STARTUP_TASK_NAME}" (per-user, not elevated)`,
          `  Trigger:         at logon, keeps running after the terminal closes`,
          `  Working dir:     ${facts?.workingDirectory ?? PROJECT_ROOT}`,
          `  Command:         ${facts ? `${facts.execute} ${facts.arguments}` : '(query failed — see startup status)'}`,
          `  Restart policy:  ${facts?.restartCount ?? '?'} restarts, ${facts?.restartInterval ?? 'PT1M'} apart, after unexpected exit`,
          '',
          '  Installing again is safe: the task is replaced, never duplicated.',
          '  Starting the agent NEVER starts an AI task — it only comes online and waits.',
          '',
          `  Start it now:    Start-ScheduledTask -TaskName ${STARTUP_TASK_NAME}`,
          '',
        ].join('\n'),
      );
      return 0;
    }

    case 'status': {
      const facts = await queryTask();
      const cfg = config();
      const pid = readPidFile(path.join(cfg.storage.workspace, 'agent.pid'));
      const alive = pid !== null && isProcessAlive(pid);
      const version = (() => {
        try {
          return (JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version?: string })
            .version ?? 'unknown';
        } catch {
          return 'unknown';
        }
      })();
      console.log(
        [
          '',
          'CodeRelay Startup',
          '',
          `  Auto-start:      ${facts ? `Enabled (Scheduled Task "${STARTUP_TASK_NAME}", state ${facts.state})` : 'Not installed'}`,
          `  Restart policy:  ${facts ? `${facts.restartCount ?? '?'} restarts, ${facts.restartInterval ?? '?'} apart` : '—'}`,
          `  Working dir:     ${facts?.workingDirectory ?? '—'}`,
          `  Agent process:   ${alive ? `RUNNING (pid ${pid})` : 'STOPPED'}`,
          `  Version:         ${version}`,
          '',
          facts ? '' : `  Install with:    npm run agent -- startup install`,
        ].join('\n'),
      );
      return 0;
    }

    case 'remove': {
      const result = await runUninstall();
      if (!result.ok) {
        console.error(`Could not remove the startup task:\n${result.output}`);
        return 1;
      }
      console.log('\n✓ CodeRelay startup removed\n\nCodeRelay itself, your projects, task history and configuration are untouched.\n');
      return 0;
    }

    default:
      console.error('Usage: remote-agent startup <install|status|remove>');
      return 1;
  }
}

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...args] = argv;

  try {
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        console.log(USAGE);
        return 0;
      case 'start':
        return await main();
      case 'stop':
        return await cmdStop();
      case 'status':
        return await cmdStatus();
      case 'doctor': {
        const report = await runDoctor();
        console.log(formatDoctorReport(report));
        return report.ok ? 0 : 1;
      }
      case 'models':
        return await cmdModels();
      case 'install-agent': {
        const result = installAgent();
        if (!result.installed) {
          console.error(`Could not install the custom agent: ${result.error}`);
          return 1;
        }
        console.log(
          result.changed
            ? `Installed "${AGENT_NAME}" -> ${result.target}`
            : `"${AGENT_NAME}" is already up to date at ${result.target}`,
        );
        return 0;
      }
      case 'uninstall-agent':
        console.log(uninstallAgent() ? `Removed ${agentTargetPath()}` : 'Custom agent was not installed.');
        return 0;
      case 'projects':
        return cmdProjects(args);
      case 'tasks':
        return cmdTasks(args);
      case 'logs':
        return cmdLogs(args);
      case 'test':
        return await cmdSelfTest();
      case 'web':
        return await cmdWeb(args);
      case 'startup':
        return await cmdStartup(args);
      default:
        console.error(`Unknown command "${command}".\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\nConfiguration error: ${err.message}\n`);
      return 2;
    }
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    return 1;
  }
}
