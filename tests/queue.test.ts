/**
 * The queue, proven rather than trusted.
 *
 * These tests drive the REAL TaskQueue and the REAL repository (real SQLite,
 * real claim SQL) with a fake runner whose completion is under test control.
 * The poll interval is set absurdly high, so every transition observed here is
 * caused by the queue's own drain logic — not by a timer getting lucky.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/db/database.js';
import { TaskRepository } from '../src/db/taskRepository.js';
import { TaskQueue } from '../src/runner/queue.js';
import type { TaskRunner } from '../src/runner/taskRunner.js';
import type { Task, TaskStatus } from '../src/domain/task.js';

/** Runner double: starts instantly, finishes only when the test says so. */
class FakeRunner {
  order: number[] = [];
  starts = new Map<number, number>();
  concurrent = 0;
  peakConcurrent = 0;
  private resolvers = new Map<number, (status: TaskStatus) => void>();

  constructor(private readonly tasks: TaskRepository) {}

  run(task: Task): Promise<void> {
    this.order.push(task.id);
    this.starts.set(task.id, (this.starts.get(task.id) ?? 0) + 1);
    this.concurrent += 1;
    this.peakConcurrent = Math.max(this.peakConcurrent, this.concurrent);

    return new Promise((resolve) => {
      this.resolvers.set(task.id, (status) => {
        this.concurrent -= 1;
        this.resolvers.delete(task.id);
        this.tasks.transition(task.id, status, status === 'FAILED' ? { error: 'simulated failure' } : {});
        resolve();
      });
    });
  }

  cancel(id: number): boolean {
    const resolver = this.resolvers.get(id);
    if (!resolver) return false;
    resolver('CANCELLED');
    return true;
  }

  isRunning(id: number): boolean {
    return this.resolvers.has(id);
  }

  finish(id: number, status: TaskStatus = 'COMPLETED'): void {
    const resolver = this.resolvers.get(id);
    assert.ok(resolver, `task #${id} is not running, cannot finish it`);
    resolver(status);
  }
}

/** Let the drain loop's microtasks and finally-handlers settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

function harness(dbPath = ':memory:', maxConcurrent = 1) {
  const db = openDatabase(dbPath);
  const tasks = new TaskRepository(db);
  const runner = new FakeRunner(tasks);
  const queue = new TaskQueue(tasks, runner as unknown as TaskRunner, {
    maxConcurrent,
    // Effectively never: only kick() and task completion may schedule.
    pollIntervalMs: 3_600_000,
  });
  return { db, tasks, runner, queue };
}

function enqueue(tasks: TaskRepository, projectId: string, prompt: string): Task {
  return tasks.create({ userId: 1, chatId: 1, projectId, prompt, approvalRequired: false, approvalReason: null });
}

describe('five-task FIFO drain', () => {
  test('tasks run strictly one at a time, oldest first, each exactly once', async () => {
    const { db, tasks, runner, queue } = harness();
    queue.start();

    const ids = [1, 2, 3, 4, 5].map((n) => enqueue(tasks, 'demo', `task ${n}`).id);
    queue.kick();
    await settle();

    // Task 1 running, 2-5 queued — the exact scenario from the specification.
    assert.equal(tasks.get(ids[0]!)!.status, 'RUNNING');
    for (const id of ids.slice(1)) assert.equal(tasks.get(id)!.status, 'QUEUED');
    assert.equal(runner.order.length, 1, 'only one task may have started');

    // Extra kicks while busy must not start anything else.
    queue.kick();
    queue.kick();
    await settle();
    assert.equal(runner.order.length, 1);
    assert.equal(runner.peakConcurrent, 1);

    // Complete them one by one; each completion must auto-start the next,
    // with the queue state correct after every transition.
    for (let i = 0; i < ids.length; i++) {
      runner.finish(ids[i]!);
      await settle();
      assert.equal(tasks.get(ids[i]!)!.status, 'COMPLETED');
      if (i + 1 < ids.length) {
        assert.equal(tasks.get(ids[i + 1]!)!.status, 'RUNNING', `#${ids[i + 1]} must start automatically`);
        for (const later of ids.slice(i + 2)) assert.equal(tasks.get(later)!.status, 'QUEUED');
      }
    }

    assert.deepEqual(runner.order, ids, 'execution order must be 1,2,3,4,5');
    assert.equal(runner.peakConcurrent, 1, 'never two tasks at once');
    for (const id of ids) assert.equal(runner.starts.get(id), 1, `#${id} must execute exactly once`);
    await queue.stop(100);
    db.close();
  });

  test('a failure does not block the queue', async () => {
    const { db, tasks, runner, queue } = harness();
    queue.start();
    const [a, b] = [enqueue(tasks, 'demo', 'will fail').id, enqueue(tasks, 'demo', 'will succeed').id];
    queue.kick();
    await settle();

    runner.finish(a, 'FAILED');
    await settle();
    assert.equal(tasks.get(a)!.status, 'FAILED');
    assert.equal(tasks.get(b)!.status, 'RUNNING', 'the next task must start after a failure');
    runner.finish(b);
    await queue.stop(100);
    db.close();
  });

  test('cancelling the running task starts the next one', async () => {
    const { db, tasks, runner, queue } = harness();
    queue.start();
    const [a, b] = [enqueue(tasks, 'demo', 'a').id, enqueue(tasks, 'demo', 'b').id];
    queue.kick();
    await settle();

    assert.equal(runner.cancel(a), true);
    await settle();
    assert.equal(tasks.get(a)!.status, 'CANCELLED');
    assert.equal(tasks.get(b)!.status, 'RUNNING');
    runner.finish(b);
    await queue.stop(100);
    db.close();
  });

  test('cancelling a queued task removes it from execution but keeps history', async () => {
    const { db, tasks, runner, queue } = harness();
    queue.start();
    const [a, b, c] = [enqueue(tasks, 'demo', 'a').id, enqueue(tasks, 'demo', 'b').id, enqueue(tasks, 'demo', 'c').id];
    queue.kick();
    await settle();

    tasks.transition(b, 'CANCELLED', { error: 'Cancelled by operator before execution.' });
    runner.finish(a);
    await settle();

    assert.equal(tasks.get(c)!.status, 'RUNNING', 'the queue must skip the cancelled task');
    assert.equal(runner.starts.get(b), undefined, 'a cancelled task must never start');
    assert.ok(tasks.get(b), 'the cancelled task remains in history');
    runner.finish(c);
    await queue.stop(100);
    db.close();
  });
});

describe('ordering rules', () => {
  test('an older task awaiting approval blocks younger tasks for the SAME project only', async () => {
    const { db, tasks, runner, queue } = harness(':memory:', 2);
    queue.start();

    const parked = tasks.create({
      userId: 1, chatId: 1, projectId: 'alpha', prompt: 'risky', approvalRequired: true, approvalReason: 'deploy',
    });
    const younger = enqueue(tasks, 'alpha', 'later work');
    const other = enqueue(tasks, 'beta', 'independent');
    queue.kick();
    await settle();

    // FIFO within a project: the younger alpha task must NOT jump the parked one.
    assert.equal(tasks.get(younger.id)!.status, 'QUEUED');
    // Other projects are unaffected by alpha's approval.
    assert.equal(tasks.get(other.id)!.status, 'RUNNING');

    // Approval resolves → the parked task re-queues with its ORIGINAL id and
    // therefore runs before the younger one.
    tasks.setApproval(parked.id, 'APPROVED');
    tasks.transition(parked.id, 'QUEUED');
    queue.kick();
    await settle();
    assert.equal(tasks.get(parked.id)!.status, 'RUNNING');
    assert.equal(tasks.get(younger.id)!.status, 'QUEUED');

    runner.finish(parked.id);
    await settle();
    assert.equal(tasks.get(younger.id)!.status, 'RUNNING');
    runner.finish(younger.id);
    runner.finish(other.id);
    await queue.stop(100);
    db.close();
  });

  test('independent projects run in parallel; the same project never does', async () => {
    const { db, tasks, runner, queue } = harness(':memory:', 3);
    queue.start();

    const a1 = enqueue(tasks, 'alpha', 'a1').id;
    const a2 = enqueue(tasks, 'alpha', 'a2').id;
    const b1 = enqueue(tasks, 'beta', 'b1').id;
    queue.kick();
    await settle();

    assert.equal(tasks.get(a1)!.status, 'RUNNING');
    assert.equal(tasks.get(b1)!.status, 'RUNNING', 'a different project may run concurrently');
    assert.equal(tasks.get(a2)!.status, 'QUEUED', 'the same project must stay single-worker');
    assert.equal(runner.peakConcurrent, 2);

    runner.finish(a1);
    await settle();
    assert.equal(tasks.get(a2)!.status, 'RUNNING');
    runner.finish(a2);
    runner.finish(b1);
    await queue.stop(100);
    db.close();
  });

  test('promotion moves a queued task to the front without touching the running one', async () => {
    const { db, tasks, runner, queue } = harness();
    queue.start();
    const ids = [1, 2, 3, 4].map((n) => enqueue(tasks, 'demo', `t${n}`).id);
    queue.kick();
    await settle();

    assert.equal(tasks.promote(ids[3]!), true);
    assert.equal(tasks.promote(ids[0]!), false, 'a running task cannot be reordered');
    assert.deepEqual(tasks.queuedInOrder().map((t) => t.id), [ids[3], ids[1], ids[2]]);

    for (const _ of ids) {
      const running = runner.order[runner.order.length - 1]!;
      runner.finish(running);
      await settle();
    }
    assert.deepEqual(runner.order, [ids[0], ids[3], ids[1], ids[2]], 'promoted task runs right after the current one');
    await queue.stop(100);
    db.close();
  });
});

describe('persistence and crash recovery', () => {
  test('the queue survives a process restart with order intact', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coderelay-queue-'));
    const file = path.join(dir, 'agent.db');

    // "Process one": enqueue five, start the first, then vanish without cleanup.
    {
      const { db, tasks, runner, queue } = harness(file);
      queue.start();
      for (let n = 1; n <= 5; n++) enqueue(tasks, 'demo', `task ${n}`);
      queue.kick();
      await settle();
      assert.equal(runner.order.length, 1);
      // No graceful queue stop and no task transition: the RUNNING row stays
      // on disk exactly as a crash would leave it. The handle is closed only
      // so Windows releases the file for "process two".
      db.close();
    }

    // "Process two": a fresh queue over the same file.
    {
      const { db, runner, queue } = harness(file);
      queue.start(); // runs recoverOrphans internally
      await settle();

      const recovered = queue.recoveryReport();
      assert.equal(recovered.requeued.length, 1, 'the interrupted task is detected, not silently re-run');
      assert.equal(recovered.requeued[0]!.retryCount, 1, 'the interruption is counted');

      // The interrupted task keeps its id, so it is STILL first in line.
      const order: number[] = [];
      queue.kick();
      await settle();
      while (runner.order.length > order.length) {
        const running = runner.order[runner.order.length - 1]!;
        order.push(running);
        runner.finish(running);
        await settle();
      }
      assert.deepEqual(order, [1, 2, 3, 4, 5], 'recovery must preserve FIFO order');
      await queue.stop(100);
      db.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a task interrupted too many times is abandoned instead of re-billed forever', () => {
    const { db, tasks } = harness();
    const task = enqueue(tasks, 'demo', 'crashy');
    for (let crash = 0; crash < 3; crash++) {
      const claimed = tasks.claimNextQueued(process.pid);
      assert.equal(claimed?.id, task.id);
      const { requeued } = tasks.recoverOrphans();
      assert.equal(requeued.length, 1);
    }
    const claimed = tasks.claimNextQueued(process.pid);
    assert.equal(claimed?.id, task.id);
    const { abandoned } = tasks.recoverOrphans();
    assert.equal(abandoned.length, 1);
    assert.equal(tasks.get(task.id)!.status, 'FAILED');
    assert.match(tasks.get(task.id)!.error ?? '', /Abandoned/);
    db.close();
  });

  test('client disconnects are irrelevant to the queue: no client reference exists', async () => {
    // Structural proof: the queue schedules from the repository alone. A task
    // created with chatId 0 (no Telegram) and no web session attached runs the
    // same as any other.
    const { db, tasks, runner, queue } = harness();
    queue.start();
    const task = tasks.create({
      userId: 0, chatId: 0, projectId: 'demo', prompt: 'origin: web, browser closed', approvalRequired: false, approvalReason: null, origin: 'web',
    });
    queue.kick();
    await settle();
    assert.equal(tasks.get(task.id)!.status, 'RUNNING');
    runner.finish(task.id);
    await settle();
    assert.equal(tasks.get(task.id)!.status, 'COMPLETED');
    await queue.stop(100);
    db.close();
  });
});
