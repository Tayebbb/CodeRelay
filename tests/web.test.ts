/**
 * The web interface as a security boundary and as an equal client of the core.
 *
 * Everything here runs against the REAL server over real HTTP on a loopback
 * port — routing, cookies, CSRF and static serving are exactly the production
 * code paths, not mocks of them.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { openDatabase } from '../src/db/database.js';
import { TaskRepository } from '../src/db/taskRepository.js';
import { ProjectRegistry } from '../src/projects/registry.js';
import { ApprovalService } from '../src/approval/service.js';
import { EventBus } from '../src/core/events.js';
import { TaskService } from '../src/core/taskService.js';
import { GitControlService } from '../src/core/gitControl.js';
import { WebServer, webNotifier } from '../src/web/server.js';
import { createPasswordFile, LoginThrottle, SessionStore, verifyPassword } from '../src/web/auth.js';
import { nullNotifier } from '../src/notify/notifier.js';
import type { AppConfig } from '../src/core/config.js';
import type { TaskQueue } from '../src/runner/queue.js';
import type { TaskRunner } from '../src/runner/taskRunner.js';
import type { CopilotInfo } from '../src/copilot/detect.js';

const PASSWORD = 'correct-horse-battery';

function testConfig(workspace: string): AppConfig {
  return {
    telegram: { botToken: '', authorizedUserIds: [], polling: false },
    provider: 'copilot',
    copilot: {
      bin: null,
      model: 'claude-opus-5',
      modelFallback: null,
      effort: null,
      agent: null,
      autopilot: true,
      maxAutopilotContinues: 5,
      sandbox: false,
    },
    limits: {
      maxAiCreditsPerTask: 10,
      maxAiCreditsPerDay: 50,
      maxTaskDurationMs: 60_000,
      maxRetries: 1,
      maxConcurrentTasks: 1,
      verifyTimeoutMs: 10_000,
      approvalTimeoutMs: 60_000,
    },
    git: {
      autoCommit: true,
      autoPush: false,
      checkpoint: true,
      requireApprovalWhenDirty: true,
      protectedBranches: ['main'],
      allowCommitWithoutVerification: false,
    },
    safety: {
      requireApprovalForDangerousActions: true,
      extraDeniedCommands: [],
      allowedUrls: [],
      envPassthrough: [],
      allowRepoInstructions: false,
      githubMcp: false,
    },
    verify: { runTests: true, runBuild: false },
    orchestration: { enabled: false, maxAgentCalls: 4, reviewThreshold: 0.75 },
    storage: {
      workspace,
      databaseFile: path.join(workspace, 'agent.db'),
      logDirectory: path.join(workspace, 'logs'),
      projectsFile: path.join(workspace, 'projects.json'),
    },
    interfaces: { telegram: false, web: true },
    web: {
      host: '127.0.0.1',
      port: 0,
      sessionTtlMs: 60 * 60 * 1000,
      authFile: path.join(workspace, 'web-auth.json'),
    },
    heartbeat: { enabled: false, hour: 9 },
    logLevel: 'error',
  };
}

const COPILOT: CopilotInfo = {
  installed: true,
  version: '1.0.0',
  launcher: { command: 'node', baseArgs: [], description: 'test', safe: true },
  models: ['claude-opus-5', 'gpt-5'],
  authenticatedUser: 'tester',
  configHome: '',
};

interface Harness {
  base: string;
  server: WebServer;
  tasks: TaskRepository;
  service: TaskService;
  approvals: ApprovalService;
  bus: EventBus;
  workspace: string;
  db: ReturnType<typeof openDatabase>;
  kicks: number[];
}

function buildHarness(
  workspace: string,
  config: AppConfig,
  extras: { bindRetryDelaysMs?: number[] } = {},
): Omit<Harness, 'base'> {
  createPasswordFile(config.web.authFile, PASSWORD);

  const bus = new EventBus();
  const db = openDatabase(config.storage.databaseFile);
  const tasks = new TaskRepository(db, bus);

  const projectDir = path.join(workspace, 'demo');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    config.storage.projectsFile,
    JSON.stringify({ projects: [{ id: 'demo', name: 'Demo', path: projectDir }] }),
  );
  const projects = new ProjectRegistry(config.storage.projectsFile);
  projects.load();

  const kicks: number[] = [];
  const queue = { kick: () => kicks.push(Date.now()), activeIds: () => [] as number[] } as unknown as TaskQueue;
  const runner = { isRunning: () => false, cancel: () => false } as unknown as TaskRunner;

  const approvals = new ApprovalService(tasks, webNotifier(bus), 60_000);
  const service = new TaskService({ config, tasks, projects, queue, runner, approvals, notifier: nullNotifier });
  const gitControl = new GitControlService({ projects, tasks });

  const server = new WebServer({
    config,
    tasks,
    projects,
    queue,
    approvals,
    service,
    gitControl,
    copilot: COPILOT,
    bus,
    startedAt: Date.now(),
    ...extras,
  });
  return { server, tasks, service, approvals, bus, workspace, db, kicks };
}

async function startHarness(): Promise<Harness> {
  const workspace = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'coderelay-web-'));
  const h = buildHarness(workspace, testConfig(workspace));
  await h.server.start();
  return { ...h, base: h.server.address() };
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function login(harness: Harness): Promise<string> {
  const response = await fetch(`${harness.base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CodeRelay': '1' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
  assert.ok(cookie, 'login must set a session cookie');
  return cookie!;
}

function authed(cookie: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Cookie: cookie, 'X-CodeRelay': '1', 'Content-Type': 'application/json', ...extra };
}

describe('web interface', () => {
  let h: Harness;
  let cookie: string;

  before(async () => {
    h = await startHarness();
    cookie = await login(h);
  });

  after(async () => {
    await h.server.stop();
    h.db.close();
    fs.rmSync(h.workspace, { recursive: true, force: true });
  });

  // ------------------------------------------------------------ authentication

  test('every API route is closed without a session', async () => {
    for (const route of ['/api/status', '/api/projects', '/api/tasks', '/api/agents', '/api/events']) {
      const response = await fetch(`${h.base}${route}`);
      assert.equal(response.status, 401, route);
    }
  });

  test('a wrong password is rejected', async () => {
    const response = await fetch(`${h.base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CodeRelay': '1' },
      body: JSON.stringify({ password: 'wrong-password-123' }),
    });
    assert.equal(response.status, 401);
  });

  test('a fabricated session cookie is rejected', async () => {
    const response = await fetch(`${h.base}/api/status`, {
      headers: { Cookie: 'coderelay_session=' + 'a'.repeat(64) },
    });
    assert.equal(response.status, 401);
  });

  test('the session cookie is HttpOnly and SameSite=Strict', async () => {
    const fresh = await fetch(`${h.base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CodeRelay': '1' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const raw = fresh.headers.getSetCookie()[0] ?? '';
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=Strict/i);
  });

  // ------------------------------------------------------------------- CSRF

  test('mutations without the custom header are refused even with a session', async () => {
    const response = await fetch(`${h.base}/api/tasks`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'demo', prompt: 'x' }),
    });
    assert.equal(response.status, 403);
  });

  test('a cross-site Origin is refused even with the header', async () => {
    const response = await fetch(`${h.base}/api/tasks`, {
      method: 'POST',
      headers: authed(cookie, { Origin: 'https://evil.example' }),
      body: JSON.stringify({ projectId: 'demo', prompt: 'x' }),
    });
    assert.equal(response.status, 403);
  });

  // ------------------------------------------------------------------ static

  test('path traversal out of the static root is refused', async () => {
    for (const attempt of ['/../package.json', '/..%2f..%2f.env', '/%2e%2e/%2e%2e/package.json', '/app.js/../../.env']) {
      const response = await fetch(`${h.base}${attempt}`);
      const text = await response.text();
      assert.ok(!text.includes('"name"'), `${attempt} must not leak files`);
      assert.ok(!text.includes('TELEGRAM'), `${attempt} must not leak .env`);
    }
  });

  test('backslash traversal (Windows separators) is refused', async () => {
    for (const attempt of ['/..%5c..%5cpackage.json', '/%2e%2e%5c%2e%2e%5c.env', '/app.js%5c..%5c..%5cpackage.json']) {
      const response = await fetch(`${h.base}${attempt}`);
      const text = await response.text();
      assert.ok(!text.includes('"scripts"'), `${attempt} must not leak files`);
    }
  });

  test('a rebound Host header is refused before any routing', async () => {
    const url = new URL(h.base);
    const status = await new Promise<number>((resolve) => {
      const request = http.get(
        { host: url.hostname, port: url.port, path: '/api/status', headers: { Host: 'attacker.example', Cookie: cookie } },
        (response) => resolve(response.statusCode ?? 0),
      );
      request.on('error', () => resolve(0));
    });
    assert.equal(status, 421);
  });

  test('the app shell is served without a session (static is public, data is not)', async () => {
    const response = await fetch(`${h.base}/`);
    assert.equal(response.status, 200);
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
  });

  // ------------------------------------------------------------------- PWA

  test('the manifest is valid and installable', async () => {
    const response = await fetch(`${h.base}/manifest.webmanifest`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /manifest\+json/);
    const manifest = (await response.json()) as Record<string, unknown>;
    assert.equal(manifest.name, 'CodeRelay');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/');
    const icons = manifest.icons as Array<{ sizes: string; purpose?: string }>;
    assert.ok(icons.some((i) => i.sizes === '192x192'));
    assert.ok(icons.some((i) => i.sizes === '512x512'));
    assert.ok(icons.some((i) => i.purpose === 'maskable'), 'a maskable icon is required for Android');
  });

  test('icons are served as real PNGs', async () => {
    for (const icon of ['/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png']) {
      const response = await fetch(`${h.base}${icon}`);
      assert.equal(response.status, 200, icon);
      const bytes = new Uint8Array(await response.arrayBuffer());
      // PNG signature — the file must actually be a PNG, not a renamed SVG.
      assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], icon);
    }
  });

  test('the service worker is served and never intercepts the API', async () => {
    const response = await fetch(`${h.base}/sw.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /javascript/);
    const source = await response.text();
    // The security property: API responses (auth, tasks, diffs, git) must be
    // network-only. The worker must bail on /api/ before any caching.
    assert.match(source, /startsWith\('\/api\/'\)/);
    assert.match(source, /if \(url\.pathname\.startsWith\('\/api\/'\)\) return;/);
    assert.doesNotMatch(source, /cache\.addAll\(\[[^\]]*api/i, 'no API path may be precached');
  });

  // ----------------------------------------------------------- shared core

  test('an oversized request body cannot wedge the server', async () => {
    // 80 KB exceeds MAX_BODY_BYTES (64 KB); the server destroys the upload.
    const big = JSON.stringify({ projectId: 'demo', prompt: 'x'.repeat(80 * 1024) });
    const response = await fetch(`${h.base}/api/tasks`, {
      method: 'POST',
      headers: authed(cookie),
      body: big,
    }).catch(() => null); // a mid-upload socket destroy surfaces as a fetch error
    if (response) assert.equal(response.status, 400);

    // The behavioural claim: the server survives and keeps answering.
    const after = await fetch(`${h.base}/api/me`, { headers: authed(cookie) });
    assert.equal(after.status, 200);
  });

  test('a task created via the web lands in the same repository Telegram reads', async () => {
    const response = await fetch(`${h.base}/api/tasks`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ projectId: 'demo', prompt: 'add a healthcheck endpoint', model: 'gpt-5' }),
    });
    assert.equal(response.status, 201);
    const { task } = (await response.json()) as { task: { id: number } };

    // The exact same row a Telegram /tasks command would read.
    const stored = h.tasks.get(task.id)!;
    assert.equal(stored.origin, 'web');
    assert.equal(stored.model, 'gpt-5');
    assert.equal(stored.prompt.includes('healthcheck'), true);
    assert.ok(h.kicks.length > 0, 'submission must kick the shared queue');
  });

  test('a task created by Telegram is visible through the web API', async () => {
    const result = h.service.submit({
      origin: 'telegram',
      userId: 42,
      chatId: 42,
      projectId: 'demo',
      prompt: 'telegram-side task',
    });
    assert.ok(result.ok);
    const createdId = result.ok ? result.task.id : -1;

    const response = await fetch(`${h.base}/api/tasks?limit=10`, { headers: { Cookie: cookie } });
    const { tasks } = (await response.json()) as { tasks: Array<{ id: number; origin: string }> };
    const found = tasks.find((t) => t.id === createdId);
    assert.equal(found?.origin, 'telegram');
  });

  test('an unknown model is refused before it reaches the core', async () => {
    const response = await fetch(`${h.base}/api/tasks`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ projectId: 'demo', prompt: 'x', model: 'made-up-model' }),
    });
    assert.equal(response.status, 400);
  });

  test('an unknown provider is refused before it reaches the core', async () => {
    const response = await fetch(`${h.base}/api/tasks`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ projectId: 'demo', prompt: 'x', provider: 'antigravity' }),
    });
    assert.equal(response.status, 400);
  });

  test('a known but uninstalled provider is refused', async () => {
    // The harness injects no claude detection, so it is not installed.
    const response = await fetch(`${h.base}/api/tasks`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ projectId: 'demo', prompt: 'x', provider: 'claude' }),
    });
    assert.equal(response.status, 400);
  });

  test('a per-task provider choice is validated against ITS catalogue and persisted', async () => {
    const bad = await fetch(`${h.base}/api/tasks`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ projectId: 'demo', prompt: 'x', provider: 'copilot', model: 'opus' }),
    });
    assert.equal(bad.status, 400, 'a model from another provider must not pass validation');

    const response = await fetch(`${h.base}/api/tasks`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ projectId: 'demo', prompt: 'use the chosen CLI', provider: 'copilot', model: 'gpt-5' }),
    });
    assert.equal(response.status, 201);
    const { task } = (await response.json()) as { task: { id: number; provider: string } };
    assert.equal(task.provider, 'copilot');
    assert.equal(h.tasks.get(task.id)!.provider, 'copilot');
  });

  test('an unregistered project is refused', async () => {
    const response = await fetch(`${h.base}/api/tasks`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ projectId: '../../etc', prompt: 'x' }),
    });
    assert.equal(response.status, 400);
  });

  test('the plan mode forbids modification in the prompt the core receives', async () => {
    const response = await fetch(`${h.base}/api/tasks`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ projectId: 'demo', prompt: 'migrate to postgres', mode: 'plan' }),
    });
    const { task } = (await response.json()) as { task: { id: number } };
    const stored = h.tasks.get(task.id)!;
    assert.match(stored.prompt, /Do NOT modify any files/);
    assert.match(stored.prompt, /migrate to postgres/);
  });

  // -------------------------------------------------------------- follow-ups

  /** A COMPLETED parent with a recorded agent session, ready to follow up on. */
  function finishedParent(sessionId: string | null): number {
    const created = h.tasks.create({
      userId: 0,
      chatId: 0,
      projectId: 'demo',
      prompt: 'fix the parser',
      approvalRequired: false,
      approvalReason: null,
      origin: 'web',
    });
    h.tasks.transition(created.id, 'RUNNING');
    if (sessionId) {
      h.tasks.updateUsage(created.id, {
        aiCredits: 1,
        outputTokens: 10,
        copilotSessionIds: [sessionId],
        unreportedRuns: 0,
      });
    }
    h.tasks.transition(created.id, 'COMPLETED');
    return created.id;
  }

  test('a follow-up inherits project, provider and the parent session', () => {
    const parentId = finishedParent('sess-abc-123');
    const result = h.service.followUp(parentId, {
      origin: 'web',
      userId: 0,
      chatId: 0,
      prompt: 'also add tests for timezone handling',
    });
    assert.ok(result.ok, result.ok ? '' : result.error);
    if (!result.ok) return;
    const stored = h.tasks.get(result.task.id)!;
    assert.equal(stored.parentTaskId, parentId);
    assert.equal(stored.resumeSessionId, 'sess-abc-123');
    assert.equal(stored.projectId, 'demo');
  });

  test('a follow-up on an unfinished task is refused', () => {
    const created = h.tasks.create({
      userId: 0,
      chatId: 0,
      projectId: 'demo',
      prompt: 'still running',
      approvalRequired: false,
      approvalReason: null,
      origin: 'web',
    });
    h.tasks.transition(created.id, 'RUNNING');
    try {
      const result = h.service.followUp(created.id, { origin: 'web', userId: 0, chatId: 0, prompt: 'more' });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /still RUNNING/);
    } finally {
      // A task left RUNNING would block later git-panel tests for this project.
      h.tasks.transition(created.id, 'CANCELLED');
    }
  });

  test('a follow-up on a task with no recorded session is refused', () => {
    const parentId = finishedParent(null);
    const result = h.service.followUp(parentId, { origin: 'web', userId: 0, chatId: 0, prompt: 'more' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /no resumable agent session/);
  });

  test('a follow-up whose provider cannot resume sessions is refused', () => {
    const created = h.tasks.create({
      userId: 0,
      chatId: 0,
      projectId: 'demo',
      prompt: 'claude task',
      approvalRequired: false,
      approvalReason: null,
      origin: 'web',
      provider: 'claude',
    });
    h.tasks.transition(created.id, 'RUNNING');
    h.tasks.updateUsage(created.id, { aiCredits: 1, outputTokens: 1, copilotSessionIds: ['s1'], unreportedRuns: 0 });
    h.tasks.transition(created.id, 'COMPLETED');
    const result = h.service.followUp(created.id, { origin: 'web', userId: 0, chatId: 0, prompt: 'more' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /cannot resume/);
  });

  test('a risky follow-up prompt still passes through the approval gate', () => {
    const parentId = finishedParent('sess-risky');
    const result = h.service.followUp(parentId, {
      origin: 'web',
      userId: 0,
      chatId: 0,
      prompt: 'now git push origin main',
    });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.awaitingApproval, true, 'the risk gate must not be bypassed by follow-ups');
  });

  test('POST /api/tasks with followUpTo creates a linked task', async () => {
    const parentId = finishedParent('sess-web-1');
    const response = await fetch(`${h.base}/api/tasks`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ prompt: 'tighten the error message', followUpTo: parentId }),
    });
    assert.equal(response.status, 201);
    const { task } = (await response.json()) as { task: { id: number; parentTaskId: number } };
    assert.equal(task.parentTaskId, parentId);
    assert.equal(h.tasks.get(task.id)!.resumeSessionId, 'sess-web-1');
  });

  test('POST /api/tasks with an unknown followUpTo is a 404', async () => {
    const response = await fetch(`${h.base}/api/tasks`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ prompt: 'x', followUpTo: 999999 }),
    });
    assert.equal(response.status, 404);
  });

  test('canFollowUp is exposed only for finished tasks with a session', async () => {
    const parentId = finishedParent('sess-flag');
    const detail = await fetch(`${h.base}/api/tasks/${parentId}`, { headers: { Cookie: cookie } });
    const { task } = (await detail.json()) as { task: { canFollowUp: boolean } };
    assert.equal(task.canFollowUp, true);

    const bare = finishedParent(null);
    const bareDetail = await fetch(`${h.base}/api/tasks/${bare}`, { headers: { Cookie: cookie } });
    const bareJson = (await bareDetail.json()) as { task: { canFollowUp: boolean } };
    assert.equal(bareJson.task.canFollowUp, false);
  });

  test('retrying a follow-up preserves the session link', () => {
    const parentId = finishedParent('sess-retry');
    const follow = h.service.followUp(parentId, { origin: 'web', userId: 0, chatId: 0, prompt: 'polish it' });
    assert.ok(follow.ok);
    if (!follow.ok) return;
    h.tasks.transition(follow.task.id, 'RUNNING');
    h.tasks.transition(follow.task.id, 'FAILED', { error: 'x' });

    const retried = h.service.retry(follow.task.id);
    assert.ok(retried.ok);
    if (!retried.ok) return;
    const clone = h.tasks.get(retried.taskId!)!;
    assert.equal(clone.parentTaskId, parentId);
    assert.equal(clone.resumeSessionId, 'sess-retry');
  });

  // -------------------------------------------------------------- git panel

  test('git status is served for a registered project and 404s otherwise', async () => {
    const known = await fetch(`${h.base}/api/projects/demo/git`, { headers: { Cookie: cookie } });
    assert.equal(known.status, 200);
    const panel = (await known.json()) as { isRepo: boolean };
    assert.equal(panel.isRepo, false, 'the harness project is deliberately not a repository');

    const unknown = await fetch(`${h.base}/api/projects/nope/git`, { headers: { Cookie: cookie } });
    assert.equal(unknown.status, 404);
  });

  test('only the fixed git action menu is accepted', async () => {
    const response = await fetch(`${h.base}/api/projects/demo/git`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ action: 'reset --hard' }),
    });
    assert.equal(response.status, 400);
  });

  test('a git action on a non-repository is refused with the reason', async () => {
    const response = await fetch(`${h.base}/api/projects/demo/git`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ action: 'pull' }),
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /not a git repository/);
  });

  test('a git action is refused while a task works in that repository', async () => {
    const task = h.tasks.create({
      userId: 0,
      chatId: 0,
      projectId: 'demo',
      prompt: 'busy',
      approvalRequired: false,
      approvalReason: null,
      origin: 'web',
    });
    h.tasks.transition(task.id, 'RUNNING');
    try {
      const response = await fetch(`${h.base}/api/projects/demo/git`, {
        method: 'POST',
        headers: authed(cookie),
        body: JSON.stringify({ action: 'push' }),
      });
      assert.equal(response.status, 409);
      const body = (await response.json()) as { error: string };
      // Any live task in the project must block it — not only the one just made.
      assert.match(body.error, /is working in this repository/);
    } finally {
      h.tasks.transition(task.id, 'CANCELLED');
    }
  });

  // -------------------------------------------------------------- approvals

  test('a pending approval can be resolved from the web and unblocks the core', async () => {
    const created = h.tasks.create({
      userId: 0,
      chatId: 0,
      projectId: 'demo',
      prompt: 'risky thing',
      approvalRequired: true,
      approvalReason: 'deployment keyword',
      origin: 'web',
    });

    const pending = h.approvals.request({
      taskId: created.id,
      chatId: 0,
      title: 'test',
      project: 'Demo',
      reason: 'deployment keyword',
      details: [],
    });

    // Deliver the decision through the real HTTP endpoint.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const response = await fetch(`${h.base}/api/tasks/${created.id}/approval`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ decision: 'APPROVED' }),
    });
    assert.equal(response.status, 200);
    assert.equal(await pending, 'APPROVED');
  });

  test('answering a non-pending approval is a 409, not an effect', async () => {
    const response = await fetch(`${h.base}/api/tasks/999999/approval`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ decision: 'APPROVED' }),
    });
    assert.equal(response.status, 409);
  });

  // ------------------------------------------------------------------- SSE

  test('live events reach a connected client', async () => {
    const received: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const url = new URL(`${h.base}/api/events`);
      const request = http.get(
        { host: url.hostname, port: url.port, path: url.pathname, headers: { Cookie: cookie } },
        (response) => {
          assert.equal(response.statusCode, 200);
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            received.push(chunk);
            if (chunk.includes('task-log')) {
              request.destroy();
              resolve();
            }
          });
          // Publish AFTER the stream is open.
          setTimeout(() => h.bus.publish('task-log', 1, { logKind: 'test', message: 'hello-sse' }), 30);
        },
      );
      request.on('error', () => resolve());
      setTimeout(() => reject(new Error('no SSE event within 3s')), 3000).unref?.();
    });
    assert.ok(received.join('').includes('hello-sse'));
  });

  test('SSE replays missed events via Last-Event-ID', async () => {
    h.bus.publish('task-log', 2, { logKind: 'x', message: 'replayed-event' });
    const collected = await new Promise<string>((resolve) => {
      const url = new URL(`${h.base}/api/events`);
      let data = '';
      const request = http.get(
        { host: url.hostname, port: url.port, path: url.pathname, headers: { Cookie: cookie, 'Last-Event-ID': '0' } },
        (response) => {
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            data += chunk;
            if (data.includes('replayed-event')) {
              request.destroy();
              resolve(data);
            }
          });
        },
      );
      setTimeout(() => { request.destroy(); resolve(data); }, 2000).unref?.();
    });
    assert.ok(collected.includes('replayed-event'));
  });
});

describe('web auth primitives', () => {
  test('password file round-trips and rejects wrong passwords', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coderelay-auth-'));
    const file = path.join(dir, 'auth.json');
    createPasswordFile(file, 'a-strong-password');
    assert.equal(verifyPassword(file, 'a-strong-password'), true);
    assert.equal(verifyPassword(file, 'a-strong-passwore'), false);
    assert.equal(verifyPassword(file, ''), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('short passwords are refused at creation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coderelay-auth-'));
    assert.throws(() => createPasswordFile(path.join(dir, 'x.json'), 'short'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('sessions expire', () => {
    const store = new SessionStore(1);
    const token = store.create();
    assert.equal(store.validate(token), true);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.equal(store.validate(token), false);
        resolve();
      }, 10);
    });
  });

  test('the login throttle closes after its budget', () => {
    const throttle = new LoginThrottle(3, 60_000);
    assert.equal(throttle.allowed('ip'), true);
    assert.equal(throttle.allowed('ip'), true);
    assert.equal(throttle.allowed('ip'), true);
    assert.equal(throttle.allowed('ip'), false);
    assert.equal(throttle.allowed('other-ip'), true);
  });
});

// ------------------------------------------------------------- bind resilience
//
// The agent used to die for good when it lost the logon race against the VPN
// adapter (WEB_HOST not assigned yet). These tests pin the survival behavior
// with a genuinely occupied port — the same errno class, deterministically.

describe('web bind resilience', () => {
  test('a held port is waited out and the server binds once it frees', async () => {
    const workspace = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'coderelay-bind-'));
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const port = (blocker.address() as { port: number }).port;

    const config = testConfig(workspace);
    config.web.port = port;
    const h = buildHarness(workspace, config, { bindRetryDelaysMs: [25] });
    const waiting: string[] = [];
    const recovered: string[] = [];
    try {
      const started = h.server.start({
        onWaiting: (message) => waiting.push(message),
        onRecovered: (message) => recovered.push(message),
      });
      await waitFor(() => waiting.length > 0);
      assert.match(waiting[0]!, /EADDRINUSE/);
      assert.equal(waiting.length, 1, 'the operator is told once, not once per attempt');

      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      assert.equal(await started, 'listening');
      assert.equal(recovered.length, 1, 'recovery is announced');

      const response = await fetch(`http://127.0.0.1:${port}/api/me`);
      assert.equal(response.status, 401, 'the late-bound server serves (and still requires auth)');
    } finally {
      await h.server.stop();
      h.db.close();
      if (blocker.listening) await new Promise<void>((resolve) => blocker.close(() => resolve()));
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('stop() during the bind wait ends the retry loop immediately', async () => {
    const workspace = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'coderelay-bind-'));
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const port = (blocker.address() as { port: number }).port;

    const config = testConfig(workspace);
    config.web.port = port;
    // A long delay proves stop() wakes the wait rather than sitting it out.
    const h = buildHarness(workspace, config, { bindRetryDelaysMs: [60_000] });
    try {
      const waiting: string[] = [];
      const started = h.server.start({ onWaiting: (message) => waiting.push(message) });
      await waitFor(() => waiting.length > 0);
      await h.server.stop();
      assert.equal(await started, 'stopped');
    } finally {
      h.db.close();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('a non-transient bind error still fails fast', async () => {
    const workspace = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'coderelay-bind-'));
    const config = testConfig(workspace);
    config.web.host = 'no-such-host.invalid'; // guaranteed unresolvable (RFC 2606)
    const h = buildHarness(workspace, config, { bindRetryDelaysMs: [10] });
    const waiting: string[] = [];
    try {
      await assert.rejects(h.server.start({ onWaiting: (message) => waiting.push(message) }));
      assert.equal(waiting.length, 0, 'a fatal error must not pretend to be a wait');
    } finally {
      await h.server.stop();
      h.db.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
