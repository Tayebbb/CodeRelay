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
    assert.equal(service.resolve(1, 'APPROVED'), false);
    db.close();
  });
});
