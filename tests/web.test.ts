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

async function startHarness(): Promise<Harness> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'coderelay-web-'));
  const config = testConfig(workspace);
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

  const server = new WebServer({
    config,
    tasks,
    projects,
    queue,
    approvals,
    service,
    copilot: COPILOT,
    bus,
    startedAt: Date.now(),
  });
  await server.start();
  return { base: server.address(), server, tasks, service, approvals, bus, workspace, db, kicks };
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
