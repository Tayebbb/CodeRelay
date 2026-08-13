import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/database.js';
import { TaskRepository } from '../src/db/taskRepository.js';
import { canTransition, InvalidTransitionError, isTerminal, TASK_STATUSES } from '../src/domain/task.js';

function repo() {
  const db = openDatabase(':memory:');
  return { db, tasks: new TaskRepository(db) };
}

const NEW_TASK = {
  userId: 1,
  chatId: 1,
  projectId: 'demo',
  prompt: 'fix the login bug',
  approvalRequired: false,
  approvalReason: null,
};

describe('task state machine', () => {
  test('terminal states are terminal', () => {
    for (const status of TASK_STATUSES) {
      const terminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(status);
      assert.equal(isTerminal(status), terminal, status);
    }
    assert.equal(canTransition('COMPLETED', 'RUNNING'), false);
  });

  test('allows the normal happy path', () => {
    assert.equal(canTransition('QUEUED', 'RUNNING'), true);
    assert.equal(canTransition('RUNNING', 'TESTING'), true);
    assert.equal(canTransition('TESTING', 'COMPLETED'), true);
  });

  test('rejects illegal jumps', () => {
    assert.equal(canTransition('QUEUED', 'TESTING'), false);
    assert.equal(canTransition('CANCELLED', 'RUNNING'), false);
  });
});

describe('task repository', () => {
  test('creates a queued task', () => {
    const { db, tasks } = repo();
    const task = tasks.create(NEW_TASK);
    assert.equal(task.status, 'QUEUED');
    assert.equal(task.approvalStatus, 'NONE');
    assert.equal(task.retryCount, 0);
    db.close();
  });

  test('creates a task awaiting approval when flagged', () => {
    const { db, tasks } = repo();
    const task = tasks.create({ ...NEW_TASK, approvalRequired: true, approvalReason: 'deployment' });
    assert.equal(task.status, 'WAITING_APPROVAL');
    assert.equal(task.approvalStatus, 'PENDING');
    db.close();
  });

  test('redacts secrets in the stored prompt', () => {
    const { db, tasks } = repo();
    const task = tasks.create({ ...NEW_TASK, prompt: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 to fix it' });
    assert.ok(!task.prompt.includes('ghp_abcdefghij'));
    db.close();
  });

  test('claims each queued task exactly once', () => {
    const { db, tasks } = repo();
    tasks.create(NEW_TASK);
    const first = tasks.claimNextQueued(111);
    const second = tasks.claimNextQueued(222);
    assert.ok(first);
    assert.equal(first!.status, 'RUNNING');
    assert.equal(second, null, 'a claimed task must never be handed out twice');
    db.close();
  });

  test('rejects invalid transitions', () => {
    const { db, tasks } = repo();
    const task = tasks.create(NEW_TASK);
    assert.throws(() => tasks.transition(task.id, 'TESTING'), InvalidTransitionError);
    db.close();
  });

  test('re-queues orphans left by a crash without losing them', () => {
    const { db, tasks } = repo();
    const task = tasks.create(NEW_TASK);
    tasks.claimNextQueued(process.pid);
    assert.equal(tasks.get(task.id)!.status, 'RUNNING');

    const recovered = tasks.recoverOrphans();
    assert.equal(recovered.length, 1);
    assert.equal(tasks.get(task.id)!.status, 'QUEUED');
    assert.equal(tasks.get(task.id)!.runnerPid, null);
    db.close();
  });

  test('tracks AI credit usage in a ledger', () => {
    const { db, tasks } = repo();
    const task = tasks.create(NEW_TASK);
    tasks.updateUsage(task.id, { aiCredits: 1.5, outputTokens: 100, copilotSessionIds: ['a'] }, 'claude-opus-4.8');
    tasks.updateUsage(task.id, { aiCredits: 4.0, outputTokens: 300, copilotSessionIds: ['a'] }, 'claude-opus-4.8');

    assert.equal(tasks.get(task.id)!.usage.aiCredits, 4.0);
    // Ledger records deltas, so the 24h total equals the latest cumulative value.
    assert.equal(tasks.creditsUsedSince(24 * 60 * 60 * 1000), 4.0);
    db.close();
  });

  test('counts only recent usage inside the window', async () => {
    const { db, tasks } = repo();
    const task = tasks.create(NEW_TASK);
    tasks.updateUsage(task.id, { aiCredits: 3, outputTokens: 0, copilotSessionIds: [] });

    assert.equal(tasks.creditsUsedSince(60_000), 3);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(tasks.creditsUsedSince(1), 0, 'usage outside the window is excluded');
    db.close();
  });

  test('deduplicates telegram updates', () => {
    const { db, tasks } = repo();
    assert.equal(tasks.markUpdateProcessed(1001), true);
    assert.equal(tasks.markUpdateProcessed(1001), false, 'a replayed update must not run twice');
    assert.equal(tasks.markUpdateProcessed(1002), true);
    db.close();
  });

  test('records an audit trail of events', () => {
    const { db, tasks } = repo();
    const task = tasks.create(NEW_TASK);
    tasks.addEvent(task.id, 'copilot', 'started');
    tasks.transition(task.id, 'RUNNING');
    const events = tasks.events(task.id);
    assert.ok(events.length >= 2);
    assert.ok(events.some((e) => e.message.includes('QUEUED -> RUNNING')));
    db.close();
  });

  test('never persists secrets in the event log', () => {
    const { db, tasks } = repo();
    const task = tasks.create(NEW_TASK);
    tasks.addEvent(task.id, 'debug', 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    assert.ok(!tasks.events(task.id).some((e) => e.message.includes('ghp_abcdefghij')));
    db.close();
  });
});
