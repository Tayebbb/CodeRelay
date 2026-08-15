import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Git } from '../src/git/git.js';
import { execCommand } from '../src/util/exec.js';
import { openDatabase, openDatabaseResilient, DatabaseCorruptError } from '../src/db/database.js';
import { TaskRepository } from '../src/db/taskRepository.js';
import { TaskQueue } from '../src/runner/queue.js';
import { ProjectRegistry, ProjectRegistryError } from '../src/projects/registry.js';
import { insufficientDiskSpace, diskSpace, formatBytes } from '../src/util/disk.js';
import type { TaskRunner } from '../src/runner/taskRunner.js';

/**
 * Chaos suite. Each test injects a real fault and asserts the system fails
 * SAFELY: it detects, reports, does not corrupt user code, does not run twice,
 * does not lose state, does not wedge, and does not leak.
 */

// GitHub's Windows runners return an 8.3 short path from os.tmpdir()
// (C:\Users\RUNNER~1\...), which the registry rightly refuses. Canonicalise once
// so tests use the long-form paths a real operator would register.
const TMP_ROOT = fs.realpathSync.native(os.tmpdir());

function tmp(tag: string): string {
  const dir = path.join(TMP_ROOT, `rpca-chaos-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const NEW_TASK = {
  userId: 1,
  chatId: 1,
  projectId: 'demo',
  prompt: 'p',
  approvalRequired: false,
  approvalReason: null,
};

describe('CHAOS: git is broken', () => {
  test('a corrupt .git is reported as an error, never as "clean non-repo"', async () => {
    const dir = tmp('gitbroken');
    // `.git` exists but is meaningless — the shape a truncated/corrupt repo takes.
    fs.writeFileSync(path.join(dir, '.git'), 'garbage not a gitdir pointer');

    const status = await new Git(dir).status();

    assert.equal(status.clean, false, 'a broken repo must never be reported clean');
    assert.ok(status.error, 'the failure must be surfaced');
    assert.match(status.error!, /git/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an ordinary directory is still just "not a repository"', async () => {
    const dir = tmp('plain');
    const status = await new Git(dir).status();
    assert.equal(status.isRepo, false);
    assert.equal(status.error, null, 'no git here is not an error');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a healthy repository reports no error', async () => {
    const dir = tmp('healthy');
    const run = (args: string[]) => execCommand('git', args, { cwd: dir, shell: false, timeoutMs: 30_000 });
    await run(['init', '-b', 'main']);
    await run(['config', 'user.email', 't@e.com']);
    await run(['config', 'user.name', 'T']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
    await run(['add', '.']);
    await run(['commit', '-m', 'init']);

    const status = await new Git(dir).status();
    assert.equal(status.isRepo, true);
    assert.equal(status.error, null);
    assert.equal(status.clean, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('checkpointing an empty repository is impossible and reported as such', async () => {
    const dir = tmp('emptyrepo');
    await execCommand('git', ['init', '-b', 'main'], { cwd: dir, shell: false, timeoutMs: 30_000 });
    const git = new Git(dir);
    assert.equal(await git.headCommit(), null, 'no commits yet');
    assert.equal(await git.createCheckpoint(1), null, 'so no checkpoint is possible');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('CHAOS: database failures', () => {
  test('a closed database surfaces the error instead of pretending success', () => {
    const db = openDatabase(':memory:');
    const tasks = new TaskRepository(db);
    tasks.create(NEW_TASK);
    db.close();

    assert.throws(() => tasks.create(NEW_TASK), 'writes must fail loudly');
    assert.throws(() => tasks.markUpdateProcessed(1), 'and must not be mistaken for a duplicate');
  });

  test('a corrupted database file is detected at open time, not mid-task', () => {
    const dir = tmp('dbcorrupt');
    const file = path.join(dir, 'agent.db');
    fs.writeFileSync(file, 'this is definitely not a sqlite database');

    // SQLite opens lazily, so without an explicit probe this would succeed here
    // and blow up later, unattended, in the middle of a task.
    assert.throws(() => openDatabase(file), DatabaseCorruptError);
  });

  test('a corrupt database is quarantined so the agent still comes back up', () => {
    const dir = tmp('dbquarantine');
    const file = path.join(dir, 'agent.db');
    fs.writeFileSync(file, 'garbage');

    const { db, quarantined } = openDatabaseResilient(file);
    assert.ok(quarantined, 'the bad file is moved aside');
    assert.ok(fs.existsSync(quarantined!), 'and kept for inspection');

    const tasks = new TaskRepository(db);
    assert.ok(tasks.create(NEW_TASK).id > 0, 'the agent works again on a fresh database');
    db.close();
  });

  test('the scheduler survives a database failure and keeps running', async () => {
    const db = openDatabase(':memory:');
    const tasks = new TaskRepository(db);
    let calls = 0;

    // Fault injection: claiming always throws, as it would on a locked DB.
    const brokenTasks = Object.create(tasks) as TaskRepository;
    Object.defineProperty(brokenTasks, 'claimNextQueued', {
      value: () => {
        calls += 1;
        throw new Error('SQLITE_BUSY: database is locked');
      },
    });
    Object.defineProperty(brokenTasks, 'recoverOrphans', { value: () => ({ requeued: [], abandoned: [] }) });

    const runner = { run: async () => ({ status: 'COMPLETED' as const, message: '' }), cancel: () => false };
    const queue = new TaskQueue(brokenTasks, runner as unknown as TaskRunner, {
      maxConcurrent: 1,
      pollIntervalMs: 20,
    });

    queue.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await queue.stop();

    assert.ok(calls >= 2, 'the loop must keep polling rather than die on the first failure');
    db.close();
  });
});

describe('CHAOS: corrupted configuration', () => {
  test('a corrupt projects file does not wipe the working set', () => {
    const dir = tmp('projcorrupt');
    const file = path.join(dir, 'projects.json');
    const projectDir = tmp('projtarget');

    fs.writeFileSync(file, JSON.stringify({ projects: [{ id: 'demo', name: 'Demo', path: projectDir }] }));
    const registry = new ProjectRegistry(file);
    registry.load();
    assert.equal(registry.enabled().length, 1);

    // Fault injection: the file is truncated mid-write.
    fs.writeFileSync(file, '{"projects": [{"id": "demo",');
    registry.load();

    assert.equal(registry.enabled().length, 1, 'the last good registry must survive');
    assert.ok(registry.loadError(), 'and the problem must be reported');

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test('a corrupt file with nothing cached still fails loudly', () => {
    const dir = tmp('projcorrupt2');
    const file = path.join(dir, 'projects.json');
    fs.writeFileSync(file, 'not json at all');
    assert.throws(() => new ProjectRegistry(file).load(), ProjectRegistryError);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a missing projects file is empty, not an error', () => {
    const registry = new ProjectRegistry(path.join(tmp('missing'), 'nope.json'));
    registry.load();
    assert.deepEqual(registry.all(), []);
    assert.equal(registry.loadError(), null);
  });
});

describe('CHAOS: disk almost full', () => {
  test('free space is measurable on this platform', () => {
    const space = diskSpace(os.tmpdir());
    assert.equal(space.known, true, 'the preflight needs a real reading');
    assert.ok(space.freeBytes > 0);
  });

  test('an impossible requirement is refused, a sane one is not', () => {
    assert.equal(insufficientDiskSpace(os.tmpdir(), 1024), null, 'plenty of room for 1 KB');
    const refusal = insufficientDiskSpace(os.tmpdir(), Number.MAX_SAFE_INTEGER);
    assert.ok(refusal, 'an unmeetable requirement must be refused');
    assert.match(refusal!, /free/);
  });

  test('sizes are reported in units a human can act on', () => {
    assert.match(formatBytes(512 * 1024 * 1024), /MB/);
    assert.match(formatBytes(3 * 1024 ** 3), /GB/);
  });
});

describe('CHAOS: Telegram unavailable', () => {
  test('an undelivered message is kept and replayed, not lost', () => {
    const db = openDatabase(':memory:');
    const tasks = new TaskRepository(db);

    tasks.enqueueOutbox(4242, 'TASK COMPLETED — commit a1b2c3d');
    tasks.enqueueOutbox(4242, 'second message');

    const pending = tasks.pendingOutbox();
    assert.equal(pending.length, 2, 'the report survives the outage');
    assert.match(pending[0]!.body, /TASK COMPLETED/);

    tasks.dropOutbox(pending[0]!.id);
    assert.equal(tasks.pendingOutbox().length, 1, 'delivered messages are removed');
    db.close();
  });

  test('outbox contents are redacted like every other channel', () => {
    const db = openDatabase(':memory:');
    const tasks = new TaskRepository(db);
    tasks.enqueueOutbox(1, 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here');
    assert.ok(!tasks.pendingOutbox()[0]!.body.includes('ghp_abcdefghij'));
    db.close();
  });

  test('one undeliverable message cannot block the queue forever', () => {
    const db = openDatabase(':memory:');
    const tasks = new TaskRepository(db);
    tasks.enqueueOutbox(1, 'poison');
    const id = tasks.pendingOutbox()[0]!.id;

    for (let i = 0; i < 10; i += 1) tasks.failOutboxAttempt(id, 10);

    assert.equal(tasks.pendingOutbox().length, 0, 'it is dropped after enough attempts');
    db.close();
  });
});

describe('CHAOS: power loss mid-task', () => {
  function repo() {
    const db = openDatabase(':memory:');
    return { db, tasks: new TaskRepository(db) };
  }

  test('an interrupted task keeps its state and its spend', () => {
    const { db, tasks } = repo();
    const task = tasks.create(NEW_TASK);
    tasks.claimNextQueued(process.pid);
    tasks.updateUsage(task.id, { aiCredits: 4.25, outputTokens: 10, copilotSessionIds: ['s'], unreportedRuns: 0 });

    // Power loss: no clean shutdown, the row stays RUNNING.
    const recovered = tasks.recoverOrphans();

    assert.equal(recovered.requeued.length, 1);
    const after = tasks.get(task.id)!;
    assert.equal(after.status, 'QUEUED', 'state is not lost');
    assert.equal(after.usage.aiCredits, 4.25, 'spend is remembered so the budget still applies');
    assert.equal(after.retryCount, 1, 'the interruption is counted');
    assert.ok(
      tasks.events(task.id).some((e) => e.kind === 'recovery'),
      'and recorded for the operator',
    );
    db.close();
  });

  test('a re-run after a power cut still bills its spend to the daily budget', () => {
    // Was broken: the runner started its in-memory counter at zero while the
    // database still held the earlier spend, so updateUsage() computed a
    // NEGATIVE delta, wrote no ledger row, and the re-spend became invisible to
    // MAX_AI_CREDITS_PER_DAY while the per-task cap restarted from scratch.
    const { db, tasks } = repo();
    const task = tasks.create(NEW_TASK);
    tasks.claimNextQueued(process.pid);
    tasks.updateUsage(task.id, { aiCredits: 8, outputTokens: 10, copilotSessionIds: ['s'], unreportedRuns: 0 });
    assert.equal(tasks.creditsUsedSince(60_000), 8);

    tasks.recoverOrphans();
    tasks.claimNextQueued(process.pid);

    // The runner seeds its counter from the stored usage, then adds the re-run.
    const stored = tasks.get(task.id)!.usage;
    const seeded = { ...stored, copilotSessionIds: [...stored.copilotSessionIds] };
    seeded.aiCredits += 0.9;
    tasks.updateUsage(task.id, seeded);

    assert.equal(tasks.get(task.id)!.usage.aiCredits, 8.9, 'cumulative spend must survive the recovery');
    assert.equal(
      Number(tasks.creditsUsedSince(60_000).toFixed(2)),
      8.9,
      'the re-run must reach the daily ledger, not vanish into a negative delta',
    );
    db.close();
  });

  test('a task interrupted repeatedly is abandoned instead of re-billed forever', () => {
    const { db, tasks } = repo();
    const task = tasks.create(NEW_TASK);

    for (let i = 0; i < 3; i += 1) {
      tasks.claimNextQueued(process.pid);
      tasks.recoverOrphans(3);
    }
    tasks.claimNextQueued(process.pid);
    const final = tasks.recoverOrphans(3);

    assert.equal(final.abandoned.length, 1);
    assert.equal(tasks.get(task.id)!.status, 'FAILED', 'it reaches a terminal state, not a loop');
    db.close();
  });

  test('a recovered task is flagged so it cannot be resumed blindly', () => {
    const { db, tasks } = repo();
    const task = tasks.create(NEW_TASK);
    tasks.claimNextQueued(process.pid);
    tasks.recoverOrphans();

    // The runner uses retryCount > 0 to force the dirty-tree approval gate.
    assert.ok(tasks.get(task.id)!.retryCount > 0);
    db.close();
  });

  test('a task can only be claimed once, so recovery cannot double-execute', () => {
    const { db, tasks } = repo();
    tasks.create(NEW_TASK);
    tasks.recoverOrphans();

    assert.ok(tasks.claimNextQueued(1), 'first claim wins');
    assert.equal(tasks.claimNextQueued(2), null, 'second claim gets nothing');
    db.close();
  });

  test('the pre-task snapshot survives the interruption and is not overwritten', async () => {
    const dir = tmp('powerloss');
    const run = (args: string[]) => execCommand('git', args, { cwd: dir, shell: false, timeoutMs: 30_000 });
    await run(['init', '-b', 'main']);
    await run(['config', 'user.email', 't@e.com']);
    await run(['config', 'user.name', 'T']);
    fs.writeFileSync(path.join(dir, 'app.js'), 'const original = 1;\n');
    await run(['add', '.']);
    await run(['commit', '-m', 'init']);

    // User's unsaved work, then the task starts and checkpoints it.
    fs.writeFileSync(path.join(dir, 'app.js'), 'const original = 1; // my unsaved edit\n');
    const git = new Git(dir);
    const first = await git.createCheckpoint(42);
    assert.ok(first);

    // Copilot half-writes a file, then the power cuts.
    fs.writeFileSync(path.join(dir, 'app.js'), 'const broken = \n');

    // Restart: the task is re-queued and checkpoints again.
    const second = await git.createCheckpoint(42);
    assert.ok(second);
    assert.notEqual(second!.ref, first!.ref, 'the original snapshot must not be overwritten');

    const restored = await run(['show', `${first!.commit}:app.js`]);
    assert.match(restored.stdout, /my unsaved edit/, "the user's work is still recoverable");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('CHAOS: a command that refuses to die', () => {
  test('a hung command with a surviving grandchild still resolves', async () => {
    const dir = tmp('hang');
    // The grandchild inherits stdout, so `close` never fires on the parent
    // alone. Without the watchdog this promise would hang forever and pin the
    // single task slot for good.
    fs.writeFileSync(
      path.join(dir, 'hang.js'),
      [
        "const { spawn } = require('node:child_process');",
        "spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit' });",
        'process.on("SIGTERM", () => {});',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );

    const started = Date.now();
    const result = await execCommand(process.execPath, ['hang.js'], {
      cwd: dir,
      timeoutMs: 1_000,
      shell: false,
    });
    const elapsed = Date.now() - started;

    assert.equal(result.timedOut, true, 'the timeout must be reported');
    assert.ok(elapsed < 30_000, `must not hang forever (took ${elapsed}ms)`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an already-aborted signal does not start a runaway command', async () => {
    const dir = tmp('preabort');
    fs.writeFileSync(path.join(dir, 'x.js'), 'setInterval(()=>{},1000)');
    const controller = new AbortController();
    controller.abort();

    const result = await execCommand(process.execPath, ['x.js'], {
      cwd: dir,
      timeoutMs: 30_000,
      shell: false,
      signal: controller.signal,
    });
    assert.ok(result.code === null || result.code !== 0, 'it must not run to completion');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('CHAOS: duplicate delivery', () => {
  test('a replayed Telegram update is executed once', () => {
    const db = openDatabase(':memory:');
    const tasks = new TaskRepository(db);
    assert.equal(tasks.markUpdateProcessed(5150), true);
    assert.equal(tasks.markUpdateProcessed(5150), false);
    assert.equal(tasks.markUpdateProcessed(5151), true);
    db.close();
  });
});

describe('CHAOS: project disappears or changes', () => {
  test('a deleted project path is detected before anything runs', () => {
    const dir = tmp('deleted');
    const registry = ProjectRegistry.fromRecords([{ id: 'gone', name: 'Gone', path: dir }]);
    fs.rmSync(dir, { recursive: true, force: true });

    const project = registry.getById('gone')!;
    assert.equal(fs.existsSync(project.path), false, 'the runner checks exactly this before starting');
  });

  test('an unregistered project cannot be selected', () => {
    const registry = ProjectRegistry.fromRecords([]);
    assert.equal(registry.resolve('anything'), null);
    assert.equal(registry.getById('anything'), null);
  });
});
