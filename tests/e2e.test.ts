import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Db } from '../src/db/database.js';
import { TaskRepository } from '../src/db/taskRepository.js';
import { ProjectRegistry } from '../src/projects/registry.js';
import { ApprovalService } from '../src/approval/service.js';
import { TaskRunner } from '../src/runner/taskRunner.js';
import { TaskQueue } from '../src/runner/queue.js';
import { loadConfig, type AppConfig } from '../src/core/config.js';
import { execCommand } from '../src/util/exec.js';
import type { CopilotInfo } from '../src/copilot/detect.js';
import type { ApprovalRequest, Notifier } from '../src/notify/notifier.js';

/**
 * End-to-end coverage of the task pipeline with a MOCK Copilot CLI.
 * No real Copilot session is started, so these tests consume zero AI credits.
 */

const FAKE_COPILOT = `
import fs from 'node:fs';
import path from 'node:path';

const mode = process.env.RPCA_FAKE_MODE ?? 'success';
const cwd = process.cwd();
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');

const args = process.argv.slice(2);
const promptIndex = args.indexOf('-p');
const prompt = promptIndex === -1 ? '' : args[promptIndex + 1];
const outDir = path.join(cwd, '.rpca-fake');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'last-prompt.txt'), prompt ?? '');
fs.writeFileSync(path.join(outDir, 'last-argv.json'), JSON.stringify(args));

emit({ type: 'session.tools_updated', data: { model: 'claude-opus-4.8' } });
emit({ type: 'assistant.turn_start', data: { turnId: '0' } });

if (mode === 'quota') {
  process.stderr.write('You have exceeded your premium request quota for this billing cycle.\\n');
  process.exit(1);
}

if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else {
  if (mode === 'success' || mode === 'fail-tests') {
    fs.writeFileSync(path.join(cwd, 'src-fix.js'), 'export const fixed = true;\\n');
  }
  if (mode === 'fail-tests') {
    fs.writeFileSync(path.join(cwd, 'BROKEN'), '1');
  }
  if (mode === 'nochange') {
    // deliberately writes nothing
  }

  emit({
    type: 'assistant.message',
    data: { messageId: 'm1', model: 'claude-opus-4.8', content: 'Applied the fix.', toolRequests: [{ name: 'str_replace_editor' }], outputTokens: 120 },
  });
  emit({ type: 'assistant.turn_end', data: { turnId: '0' } });
  emit({
    type: 'result',
    sessionId: 'fake-session-1',
    exitCode: 0,
    usage: {
      premiumRequests: Number(process.env.RPCA_FAKE_CREDITS ?? '1.25'),
      codeChanges: { linesAdded: 1, linesRemoved: 0, filesModified: ['src-fix.js'] },
    },
  });
  process.exit(0);
}
`;

const TEST_RUNNER = `
import fs from 'node:fs';
if (fs.existsSync('BROKEN')) {
  console.error('AssertionError: expected 200 but received 401');
  process.exit(1);
}
console.log('12 passing');
process.exit(0);
`;

let root: string;
let projectDir: string;
let fakeCopilotPath: string;
let db: Db;
let tasks: TaskRepository;
let messages: string[];
let approvalRequests: ApprovalRequest[];
let notifier: Notifier;

async function git(args: string[], cwd = projectDir) {
  return execCommand('git', args, { cwd, shell: false, timeoutMs: 30_000 });
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const saved = { ...process.env };
  process.env.TELEGRAM_BOT_TOKEN = '123:test';
  process.env.AUTHORIZED_TELEGRAM_USER_ID = '4242';
  process.env.AGENT_WORKSPACE = path.join(root, 'workspace');
  const config = loadConfig();
  process.env = saved;

  return {
    ...config,
    ...overrides,
    limits: { ...config.limits, maxTaskDurationMs: 60_000, maxRetries: 1, ...(overrides.limits ?? {}) },
    git: { ...config.git, requireApprovalWhenDirty: false, ...(overrides.git ?? {}) },
  };
}

const copilotInfo = (): CopilotInfo => ({
  installed: true,
  version: '1.0.63-fake',
  launcher: { command: process.execPath, baseArgs: [fakeCopilotPath], description: 'fake copilot', safe: true },
  models: ['claude-opus-4.8', 'claude-sonnet-4.6'],
  authenticatedUser: 'test-user',
  configHome: root,
});

function makeRunner(config: AppConfig) {
  const registry = ProjectRegistry.fromRecords([
    { id: 'demo', name: 'Demo', path: projectDir, testCommand: 'node run-tests.mjs' },
  ]);
  const approvals = new ApprovalService(tasks, notifier, config.limits.approvalTimeoutMs);
  const runner = new TaskRunner({ config, tasks, projects: registry, notifier, approvals, copilot: copilotInfo() });
  return { runner, approvals, registry };
}

function newTask(prompt = 'Fix the login bug') {
  return tasks.create({
    userId: 4242,
    chatId: 4242,
    projectId: 'demo',
    prompt,
    approvalRequired: false,
    approvalReason: null,
  });
}

before(async () => {
  root = path.join(os.tmpdir(), `rpca-e2e-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  fakeCopilotPath = path.join(root, 'fake-copilot.mjs');
  fs.writeFileSync(fakeCopilotPath, FAKE_COPILOT);
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  delete process.env.RPCA_FAKE_MODE;
  delete process.env.RPCA_FAKE_CREDITS;

  projectDir = path.join(root, `project-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'run-tests.mjs'), TEST_RUNNER);
  fs.writeFileSync(path.join(projectDir, 'app.js'), 'export const app = 1;\n');
  // Mock-CLI scratch output must not look like a project change.
  fs.writeFileSync(path.join(projectDir, '.gitignore'), '.rpca-fake/\n');

  await git(['init', '-b', 'work']);
  await git(['config', 'user.email', 'agent@example.com']);
  await git(['config', 'user.name', 'Agent']);
  await git(['config', 'commit.gpgsign', 'false']);
  await git(['add', '.']);
  await git(['commit', '-m', 'initial']);

  db = openDatabase(':memory:');
  tasks = new TaskRepository(db);
  messages = [];
  approvalRequests = [];
  notifier = {
    async sendMessage(_chatId, text) {
      messages.push(text);
    },
    async requestApproval(request) {
      approvalRequests.push(request);
    },
  };
});

describe('end-to-end task execution', () => {
  test('happy path: edits, verifies, commits and reports', async () => {
    const config = baseConfig();
    const { runner } = makeRunner(config);
    const task = newTask();

    tasks.claimNextQueued(process.pid);
    const outcome = await runner.run(task);

    assert.equal(outcome.status, 'COMPLETED');
    const finished = tasks.get(task.id)!;
    assert.equal(finished.status, 'COMPLETED');
    assert.ok(finished.commitHash, 'a commit was created');
    assert.equal(finished.branch, 'work');
    assert.ok(finished.result!.filesChanged.includes('src-fix.js'));
    assert.equal(finished.result!.verifications[0]!.passed, true);
    assert.equal(finished.usage.aiCredits, 1.25, 'AI usage is recorded');

    const log = await git(['log', '-1', '--pretty=%s']);
    assert.ok(log.stdout.includes('Fix the login bug'));

    const report = messages.at(-1)!;
    assert.ok(report.includes('TASK COMPLETED'));
    assert.ok(report.includes('src-fix.js'));
    assert.ok(report.includes('1.25 credits'));
  });

  test('passes narrow permissions and the prompt safely to the CLI', async () => {
    const config = baseConfig();
    const { runner } = makeRunner(config);
    tasks.claimNextQueued(process.pid);
    await runner.run(newTask('Fix "it"; rm -rf / && echo $(whoami)'));

    const argv = JSON.parse(fs.readFileSync(path.join(projectDir, '.rpca-fake', 'last-argv.json'), 'utf8')) as string[];
    assert.ok(!argv.includes('--yolo') && !argv.includes('--allow-all'));
    assert.ok(!argv.includes('--allow-all-paths'));
    assert.ok(argv.includes('--deny-tool=shell(rm)'));
    assert.ok(argv.includes('--deny-tool=shell(git push)'));
    assert.ok(argv.includes('--no-ask-user'));

    const prompt = fs.readFileSync(path.join(projectDir, '.rpca-fake', 'last-prompt.txt'), 'utf8');
    assert.ok(prompt.includes('rm -rf / && echo $(whoami)'), 'passed as inert argv text');
    assert.ok(prompt.includes('Do NOT create a git commit'));
  });

  test('retries a failing test run, then stops and reports instead of looping', async () => {
    process.env.RPCA_FAKE_MODE = 'fail-tests';
    const config = baseConfig({ limits: { ...baseConfig().limits, maxRetries: 1 } });
    const { runner } = makeRunner(config);
    const task = newTask();

    tasks.claimNextQueued(process.pid);
    const outcome = await runner.run(task);

    assert.equal(outcome.status, 'FAILED');
    const finished = tasks.get(task.id)!;
    assert.equal(finished.commitHash, null, 'nothing is committed when verification fails');
    assert.ok(finished.error!.includes('test failed'));
    assert.ok(finished.error!.includes('401'), 'the real failure output is reported');

    const copilotEvents = tasks.events(task.id).filter((e) => e.kind === 'copilot');
    assert.equal(copilotEvents.length, 2, 'one initial attempt plus exactly one retry');
  });

  test('stops immediately and reports when Copilot signals a quota problem', async () => {
    process.env.RPCA_FAKE_MODE = 'quota';
    const config = baseConfig();
    const { runner } = makeRunner(config);
    const task = newTask();

    tasks.claimNextQueued(process.pid);
    const outcome = await runner.run(task);

    assert.equal(outcome.status, 'FAILED');
    assert.ok(messages.some((m) => m.includes('included usage is exhausted')));
    assert.ok(messages.some((m) => m.includes('No additional paid usage was enabled')));
    assert.equal(tasks.events(task.id).filter((e) => e.kind === 'copilot').length, 1, 'no retry after a quota stop');
  });

  test('refuses to start when the daily credit budget is spent', async () => {
    const config = baseConfig();
    config.limits.maxAiCreditsPerDay = 2;

    const primer = newTask('earlier task');
    tasks.updateUsage(primer.id, { aiCredits: 5, outputTokens: 0, copilotSessionIds: [] });

    const { runner } = makeRunner(config);
    const task = newTask();
    tasks.claimNextQueued(process.pid);
    tasks.transition(task.id, 'QUEUED');
    tasks.claimNextQueued(process.pid);

    const outcome = await runner.run(task);
    assert.equal(outcome.status, 'FAILED');
    assert.ok(outcome.message.includes('Daily AI credit budget reached'));
    assert.ok(!fs.existsSync(path.join(projectDir, '.rpca-fake')), 'Copilot was never launched');
  });

  test('protects uncommitted work: asks for approval and aborts on rejection', async () => {
    const config = baseConfig();
    config.git.requireApprovalWhenDirty = true;

    fs.writeFileSync(path.join(projectDir, 'app.js'), 'export const app = 2; // my unsaved work\n');
    fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'do not lose this\n');

    const { runner, approvals } = makeRunner(config);
    const task = newTask();
    tasks.claimNextQueued(process.pid);

    const pending = runner.run(task);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(approvalRequests.length, 1);
    assert.ok(approvalRequests[0]!.reason.includes('uncommitted'));
    approvals.resolve(task.id, 'REJECTED');

    const outcome = await pending;
    assert.equal(outcome.status, 'CANCELLED');
    assert.equal(fs.readFileSync(path.join(projectDir, 'app.js'), 'utf8'), 'export const app = 2; // my unsaved work\n');
    assert.equal(fs.readFileSync(path.join(projectDir, 'notes.txt'), 'utf8'), 'do not lose this\n');
    assert.ok(!fs.existsSync(path.join(projectDir, '.rpca-fake')), 'Copilot never ran');
  });

  test('creates a recoverable checkpoint of uncommitted work before running', async () => {
    const config = baseConfig();
    fs.writeFileSync(path.join(projectDir, 'app.js'), 'export const app = 3; // user edit\n');

    const { runner } = makeRunner(config);
    const task = newTask();
    tasks.claimNextQueued(process.pid);
    await runner.run(task);

    const ref = `refs/remote-agent/checkpoint-${task.id}`;
    const show = await git(['show', `${ref}:app.js`]);
    assert.equal(show.code, 0, 'the checkpoint ref exists');
    assert.ok(show.stdout.includes('user edit'), 'the checkpoint contains the pre-task content');
  });

  test('never commits secret files even when the agent creates them', async () => {
    const config = baseConfig();
    fs.writeFileSync(path.join(projectDir, '.env'), 'API_KEY=supersecret\n');

    const { runner } = makeRunner(config);
    const task = newTask();
    tasks.claimNextQueued(process.pid);
    await runner.run(task);

    const committed = await git(['show', '--name-only', '--pretty=format:', 'HEAD']);
    assert.ok(!committed.stdout.includes('.env'), '.env must never be committed');

    const report = messages.at(-1)!;
    assert.ok(!report.includes('supersecret'));
    assert.ok(!report.includes('.env'));
  });

  test('cancellation stops the run promptly', async () => {
    process.env.RPCA_FAKE_MODE = 'hang';
    const config = baseConfig();
    const { runner } = makeRunner(config);
    const task = newTask();
    tasks.claimNextQueued(process.pid);

    const pending = runner.run(task);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(runner.isRunning(task.id), true);
    assert.equal(runner.cancel(task.id), true);

    const outcome = await pending;
    assert.equal(outcome.status, 'CANCELLED');
    assert.equal(tasks.get(task.id)!.status, 'CANCELLED');
  });

  test('times out a stuck agent instead of running forever', async () => {
    process.env.RPCA_FAKE_MODE = 'hang';
    const config = baseConfig();
    config.limits.maxTaskDurationMs = 1_200;

    const { runner } = makeRunner(config);
    const task = newTask();
    tasks.claimNextQueued(process.pid);

    const outcome = await runner.run(task);
    assert.equal(outcome.status, 'TIMED_OUT');
    assert.ok(messages.some((m) => m.includes('time limit')));
  });

  test('does not commit when nothing changed', async () => {
    process.env.RPCA_FAKE_MODE = 'nochange';
    const config = baseConfig();
    const { runner } = makeRunner(config);
    const task = newTask();
    tasks.claimNextQueued(process.pid);

    const outcome = await runner.run(task);
    assert.equal(outcome.status, 'COMPLETED');
    assert.equal(tasks.get(task.id)!.commitHash, null);
    assert.ok(messages.at(-1)!.includes('no files were modified'));
  });

  test('requires approval before committing to a protected branch', async () => {
    const config = baseConfig();
    config.git.protectedBranches = ['work'];

    const { runner, approvals } = makeRunner(config);
    const task = newTask();
    tasks.claimNextQueued(process.pid);

    const pending = runner.run(task);
    const deadline = Date.now() + 15_000;
    while (approvalRequests.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(approvalRequests.length, 1);
    assert.ok(approvalRequests[0]!.title.includes('protected branch'));
    approvals.resolve(task.id, 'REJECTED');

    await pending;
    assert.equal(tasks.get(task.id)!.commitHash, null, 'a rejected commit must not happen');
  });
});

describe('queue behaviour', () => {
  test('runs queued tasks and never double-executes one', async () => {
    const config = baseConfig();
    const { runner } = makeRunner(config);
    const queue = new TaskQueue(tasks, runner, { maxConcurrent: 1, pollIntervalMs: 50 });

    const first = newTask('first task');
    const second = newTask('second task');
    queue.start();

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const a = tasks.get(first.id)!;
      const b = tasks.get(second.id)!;
      if (['COMPLETED', 'FAILED'].includes(a.status) && ['COMPLETED', 'FAILED'].includes(b.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await queue.stop();

    assert.equal(tasks.get(first.id)!.status, 'COMPLETED');
    assert.equal(tasks.get(second.id)!.status, 'COMPLETED');

    for (const id of [first.id, second.id]) {
      const claims = tasks.events(id).filter((e) => e.message === 'Task claimed by runner');
      assert.equal(claims.length, 1, `task #${id} must be claimed exactly once`);
    }
  });
});
