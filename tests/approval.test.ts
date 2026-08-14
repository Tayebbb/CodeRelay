import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk } from '../src/approval/risk.js';
import { ApprovalService } from '../src/approval/service.js';
import { openDatabase } from '../src/db/database.js';
import { TaskRepository } from '../src/db/taskRepository.js';
import type { ApprovalRequest, Notifier } from '../src/notify/notifier.js';

describe('risk classification', () => {
  test('treats ordinary coding work as normal', () => {
    const prompts = [
      'Fix the authentication bug and run the tests',
      'Add a regression test for the dashboard API',
      'Refactor auth.service.ts to remove the duplicated guard',
      'Run the build and tell me if it passes',
    ];
    for (const prompt of prompts) {
      assert.equal(assessRisk(prompt).level, 'normal', prompt);
    }
  });

  test('flags destructive, credential and deployment requests', () => {
    const cases: Array<[string, string]> = [
      ['Delete all files in the src directory', 'destructive-files'],
      ['Run the database migration against production', 'db-migration'],
      ['Install postgres globally with apt', 'system-packages'],
      ['Read the .env file and tell me the API key', 'credentials'],
      ['Deploy this to production', 'deployment'],
      ['Push the fix to origin main', 'push'],
      ['Do a git reset --hard and force-push', 'destructive-git'],
      ['Open the firewall port 8080 with netsh', 'network-config'],
      ['Run it with sudo', 'shell-escape'],
      ['Also update C:\\Windows\\System32 config', 'outside-project'],
    ];
    for (const [prompt, ruleId] of cases) {
      const assessment = assessRisk(prompt);
      assert.equal(assessment.level, 'elevated', prompt);
      assert.ok(assessment.matched.some((rule) => rule.id === ruleId), `${prompt} -> ${ruleId}`);
    }
  });

  test('explains why approval is needed', () => {
    const assessment = assessRisk('deploy to production and push to origin');
    assert.ok(assessment.reason && assessment.reason.length > 0);
  });
});

describe('approval workflow', () => {
  function harness() {
    const db = openDatabase(':memory:');
    const tasks = new TaskRepository(db);
    const sent: ApprovalRequest[] = [];
    const notifier: Notifier = {
      async sendMessage() {},
      async requestApproval(request) {
        sent.push(request);
      },
    };
    return { db, tasks, sent, notifier };
  }

  const request = (taskId: number): ApprovalRequest => ({
    taskId,
    chatId: 1,
    title: 'Push to remote',
    project: 'demo',
    reason: 'AUTO_PUSH is enabled',
    details: [],
  });

  test('an undeliverable approval card fails fast instead of blocking for the timeout', async () => {
    // The bot used to swallow send failures, so the task held the only queue
    // slot for the full APPROVAL_TIMEOUT_MINUTES waiting for a tap on a card
    // that was never delivered.
    const { db, tasks } = harness();
    const notifier: Notifier = {
      async sendMessage() {},
      async requestApproval() {
        throw new Error('Telegram unreachable');
      },
    };
    const task = tasks.create({
      userId: 1,
      chatId: 1,
      projectId: 'demo',
      prompt: 'deploy',
      approvalRequired: true,
      approvalReason: 'deployment',
    });
    // A long timeout: the point is that we do NOT wait for it.
    const service = new ApprovalService(tasks, notifier, 10 * 60_000);

    const started = Date.now();
    const outcome = await service.request(request(task.id));

    assert.equal(outcome, 'REJECTED');
    assert.ok(Date.now() - started < 2_000, 'must not wait for the approval timeout');
    assert.equal(service.isPending(task.id), false, 'the waiter must not be left behind');
    assert.ok(
      tasks.events(task.id).some((e) => /Could not deliver approval request/.test(e.message)),
      'the operator must be able to see why it was rejected',
    );
    db.close();
  });

  test('blocks until the operator approves', async () => {
    const { db, tasks, sent, notifier } = harness();
    const task = tasks.create({
      userId: 1,
      chatId: 1,
      projectId: 'demo',
      prompt: 'deploy',
      approvalRequired: true,
      approvalReason: 'deployment',
    });
    const service = new ApprovalService(tasks, notifier, 5_000);

    const pending = service.request(request(task.id));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1, 'operator was notified');
    assert.equal(service.isPending(task.id), true);

    service.resolve(task.id, 'APPROVED');
    assert.equal(await pending, 'APPROVED');
    assert.equal(tasks.get(task.id)!.approvalStatus, 'APPROVED');
    db.close();
  });
  test('propagates a rejection', async () => {
    const { db, tasks, notifier } = harness();
    const task = tasks.create({
      userId: 1,
      chatId: 1,
      projectId: 'demo',
      prompt: 'delete everything',
      approvalRequired: true,
      approvalReason: 'destructive',
    });
    const service = new ApprovalService(tasks, notifier, 5_000);

    const pending = service.request(request(task.id));
    await new Promise((resolve) => setImmediate(resolve));
    service.resolve(task.id, 'REJECTED');

    assert.equal(await pending, 'REJECTED');
    assert.equal(tasks.get(task.id)!.approvalStatus, 'REJECTED');
    db.close();
  });

  test('expires instead of hanging forever', async () => {
    const { db, tasks, notifier } = harness();
    const task = tasks.create({
      userId: 1,
      chatId: 1,
      projectId: 'demo',
      prompt: 'x',
      approvalRequired: true,
      approvalReason: 'r',
    });
    const service = new ApprovalService(tasks, notifier, 60);

    assert.equal(await service.request(request(task.id)), 'EXPIRED');
    assert.equal(tasks.get(task.id)!.approvalStatus, 'EXPIRED');
    db.close();
  });

  test('reports when nothing is awaiting a decision', () => {
    const { db, tasks, notifier } = harness();
    tasks.create({
      userId: 1,
      chatId: 1,
      projectId: 'demo',
      prompt: 'x',
      approvalRequired: false,
      approvalReason: null,
    });
    const service = new ApprovalService(tasks, notifier, 1_000);
    assert.equal(service.resolve(1, 'APPROVED'), 'not-pending');
    db.close();
  });

  test('never writes an event for an unknown task id', () => {
    const { db, tasks, notifier } = harness();
    const service = new ApprovalService(tasks, notifier, 1_000);
    // A foreign-key violation here would throw inside the Telegram handler and
    // leave the operator staring at a spinner.
    assert.doesNotThrow(() => service.resolve(999_999, 'APPROVED'));
    assert.equal(service.resolve(999_999, 'APPROVED'), 'not-pending');
    db.close();
  });

  test('refuses a decision from a different operator', async () => {
    const { db, tasks, notifier } = harness();
    const task = tasks.create({
      userId: 111,
      chatId: 1,
      projectId: 'demo',
      prompt: 'x',
      approvalRequired: true,
      approvalReason: 'r',
    });
    const service = new ApprovalService(tasks, notifier, 5_000);
    const pending = service.request(request(task.id));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(service.resolve(task.id, 'APPROVED', 222), 'forbidden');
    assert.equal(service.isPending(task.id), true, 'still waiting after a foreign decision');
    assert.equal(service.resolve(task.id, 'APPROVED', 111), 'resolved');
    assert.equal(await pending, 'APPROVED');
    db.close();
  });

  test('an abort signal abandons the wait so cancellation is not a lie', async () => {
    const { db, tasks, notifier } = harness();
    const task = tasks.create({
      userId: 1,
      chatId: 1,
      projectId: 'demo',
      prompt: 'x',
      approvalRequired: true,
      approvalReason: 'r',
    });
    const service = new ApprovalService(tasks, notifier, 60_000);
    const controller = new AbortController();

    const pending = service.request(request(task.id), { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    assert.equal(await pending, 'REJECTED');
    assert.equal(service.isPending(task.id), false);
    db.close();
  });
});
