/**
 * The web interface: a second, optional client of the same core.
 *
 * Design rules, in order:
 *   1. No business logic here. Submission, cancellation, retry and approvals
 *      all go through the SAME TaskService/ApprovalService Telegram uses.
 *   2. Everything under /api requires a session except login itself.
 *   3. Mutations additionally require a custom header and a same-origin
 *      Origin — forms cannot set custom headers, so classic CSRF is out.
 *   4. Live updates are Server-Sent Events from the shared bus: no WebSocket
 *      dependency, ordinary cookie auth, replay via Last-Event-ID.
 *   5. Binds to localhost unless the operator explicitly says otherwise.
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, type AppConfig } from '../core/config.js';
import { createLogger, errorMessage } from '../core/logger.js';
import { redact } from '../core/redact.js';
import type { EventBus, BusEvent } from '../core/events.js';
import type { TaskService } from '../core/taskService.js';
import type { TaskRepository } from '../db/taskRepository.js';
import type { ProjectRegistry } from '../projects/registry.js';
import type { TaskQueue } from '../runner/queue.js';
import type { ApprovalService } from '../approval/service.js';
import type { CopilotInfo } from '../copilot/detect.js';
import { selectModel } from '../copilot/detect.js';
import type { ApprovalRequest, Notifier } from '../notify/notifier.js';
import { Git } from '../git/git.js';
import { LoginThrottle, passwordFileExists, SessionStore, verifyPassword } from './auth.js';
import { isProviderId, PROVIDER_IDS, selectProvider, type ProviderId, type ProviderInfo } from '../providers/index.js';

const log = createLogger('web');

const SESSION_COOKIE = 'coderelay_session';
const CSRF_HEADER = 'x-coderelay';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_DIFF_BYTES = 200 * 1024;
const SSE_HEARTBEAT_MS = 25_000;

/**
 * Chat modes shape the prompt on the SERVER so the orchestrator (which already
 * keys off wording for complexity and review decisions) sees the intent. The
 * frontend sends only the mode name.
 */
const MODE_DIRECTIVES: Record<string, string> = {
  code: '',
  plan: 'Produce a concrete implementation plan for the following, as a numbered list with file paths. Do NOT modify any files.\n\n',
  review: 'Review the code relevant to the following and report problems with file/line references. Do NOT modify any files.\n\n',
  debug: 'Diagnose the following problem. Reproduce it if possible, identify the root cause, then fix it with the smallest correct change.\n\n',
  ask: 'Answer the following question about this repository. Do NOT modify any files.\n\n',
};

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export interface WebServerDeps {
  config: AppConfig;
  tasks: TaskRepository;
  projects: ProjectRegistry;
  queue: TaskQueue;
  approvals: ApprovalService;
  service: TaskService;
  copilot: CopilotInfo;
  /** Startup detection results for every known provider, keyed by id. */
  providers?: Partial<Record<ProviderId, ProviderInfo>>;
  bus: EventBus;
  startedAt: number;
}

/**
 * Approval delivery for the web: publish the request on the bus so every open
 * page shows the card. sendMessage is a no-op — ordinary messages reach the
 * web through the repository and progress taps.
 */
export function webNotifier(bus: EventBus): Notifier {
  return {
    async sendMessage() {},
    async requestApproval(request: ApprovalRequest) {
      bus.publish('approval-requested', request.taskId, {
        title: request.title,
        project: request.project,
        reason: request.reason,
        details: request.details.join('\n'),
      });
    },
  };
}

export class WebServer {
  private readonly server: http.Server;
  private readonly sessions: SessionStore;
  private readonly throttle = new LoginThrottle();
  private readonly sseClients = new Set<ServerResponse>();
  private readonly staticRoot = path.join(PROJECT_ROOT, 'web');
  private heartbeat: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Availability of non-active providers, probed once on first request. */
  private providerCache: Array<Record<string, unknown>> | null = null;

  constructor(private readonly deps: WebServerDeps) {
    this.sessions = new SessionStore(deps.config.web.sessionTtlMs);
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        log.error('Request handler failed', { error: errorMessage(err) });
        if (!res.headersSent) this.json(res, 500, { error: 'Internal error' });
        else res.end();
      });
    });
    // SSE connections are long-lived on purpose.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 30_000;
  }

  async start(): Promise<void> {
    const { host, port, authFile } = this.deps.config.web;
    if (!passwordFileExists(authFile)) {
      throw new Error(
        'The web interface has no password yet. Create one with:  npm run agent -- web setup',
      );
    }

    this.unsubscribe = this.deps.bus.subscribe((event) => this.broadcast(event));
    this.heartbeat = setInterval(() => {
      for (const client of this.sseClients) client.write(': keepalive\n\n');
    }, SSE_HEARTBEAT_MS);
    this.heartbeat.unref?.();

    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    log.info('Web interface listening', { host, port });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const client of this.sseClients) client.end();
    this.sseClients.clear();
    this.sessions.revokeAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  address(): string {
    const bound = this.server.address();
    if (bound && typeof bound === 'object') return `http://${this.deps.config.web.host}:${bound.port}`;
    return `http://${this.deps.config.web.host}:${this.deps.config.web.port}`;
  }

  // ------------------------------------------------------------------ routing

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Pin the Host header to where we actually listen. A DNS-rebinding page
    // makes the browser send its own hostname here; refusing it up front means
    // the Origin comparison below can never be gamed into agreeing with it.
    if (!this.hostAllowed(req.headers.host)) {
      return this.json(res, 421, { error: 'Wrong host' });
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname;
    const method = req.method ?? 'GET';

    if (route.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');

      if (method !== 'GET' && method !== 'HEAD' && !this.csrfOk(req)) {
        return this.json(res, 403, { error: 'Cross-origin request refused' });
      }

      if (route === '/api/login' && method === 'POST') return this.handleLogin(req, res);

      if (!this.sessions.validate(this.cookie(req))) {
        return this.json(res, 401, { error: 'Not signed in' });
      }

      if (route === '/api/logout' && method === 'POST') {
        this.sessions.revoke(this.cookie(req));
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        return this.json(res, 200, { ok: true });
      }
      if (route === '/api/me' && method === 'GET') return this.json(res, 200, { ok: true });
      if (route === '/api/status' && method === 'GET') return this.handleStatus(res);
      if (route === '/api/projects' && method === 'GET') return this.handleProjects(res);
      if (route === '/api/agents' && method === 'GET') return this.handleAgents(res);
      if (route === '/api/tasks' && method === 'GET') return this.handleTaskList(url, res);
      if (route === '/api/tasks' && method === 'POST') return this.handleTaskCreate(req, res);
      if (route === '/api/events' && method === 'GET') return this.handleSse(req, res);

      const taskMatch = /^\/api\/tasks\/(\d{1,10})(\/(cancel|retry|approval|diff|promote))?$/.exec(route);
      if (taskMatch) {
        const id = Number.parseInt(taskMatch[1]!, 10);
        const action = taskMatch[3];
        if (!action && method === 'GET') return this.handleTaskDetail(id, res);
        if (action === 'diff' && method === 'GET') return this.handleTaskDiff(id, res);
        if (action === 'cancel' && method === 'POST') {
          const result = this.deps.service.cancel(id);
          return this.json(res, result.ok ? 200 : 409, result);
        }
        if (action === 'retry' && method === 'POST') {
          const result = this.deps.service.retry(id);
          return this.json(res, result.ok ? 200 : 409, result);
        }
        if (action === 'promote' && method === 'POST') {
          const result = this.deps.service.promote(id);
          return this.json(res, result.ok ? 200 : 409, result);
        }
        if (action === 'approval' && method === 'POST') return this.handleApproval(id, req, res);
      }

      return this.json(res, 404, { error: 'Not found' });
    }

    if (method !== 'GET' && method !== 'HEAD') return this.json(res, 405, { error: 'Method not allowed' });
    return this.serveStatic(route, res);
  }

  // ------------------------------------------------------------------- authn

  private hostAllowed(header: string | undefined): boolean {
    if (!header) return false;
    const hostname = header.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    const bound = this.deps.config.web.host.toLowerCase();
    if (hostname === bound) return true;
    // The loopback bind is reachable under its usual aliases.
    if (bound === '127.0.0.1' || bound === 'localhost' || bound === '::1') {
      return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
    }
    // A wildcard bind answers on names we cannot enumerate. Sessions and the
    // custom-header requirement still hold: a rebound origin has no cookie.
    return bound === '0.0.0.0' || bound === '::';
  }

  private cookie(req: IncomingMessage): string | null {
    const header = req.headers.cookie ?? '';
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === SESSION_COOKIE) return rest.join('=') || null;
    }
    return null;
  }

  /**
   * Forms cannot set custom headers and SameSite=Strict keeps the cookie off
   * cross-site requests; the Origin check is the belt to those braces.
   */
  private csrfOk(req: IncomingMessage): boolean {
    if ((req.headers[CSRF_HEADER] ?? '') !== '1') return false;
    const origin = req.headers.origin;
    if (origin) {
      try {
        return new URL(origin).host === req.headers.host;
      } catch {
        return false;
      }
    }
    return true;
  }

  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = req.socket.remoteAddress ?? 'unknown';
    if (!this.throttle.allowed(key)) {
      return this.json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    }

    const body = await this.readJson(req);
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!password || !verifyPassword(this.deps.config.web.authFile, password)) {
      return this.json(res, 401, { error: 'Wrong password' });
    }

    const token = this.sessions.create();
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.deps.config.web.sessionTtlMs / 1000)}`,
    );
    this.json(res, 200, { ok: true });
  }

  // ------------------------------------------------------------------- reads

  private handleStatus(res: ServerResponse): void {
    const { tasks, queue, config, copilot, startedAt } = this.deps;
    const selection = selectModel(config.copilot.model, config.copilot.modelFallback, copilot.models);
    this.json(res, 200, {
      uptimeMs: Date.now() - startedAt,
      running: queue.activeIds(),
      queued: tasks.listByStatus('QUEUED').length,
      queue: tasks.queuedInOrder().map((t) => t.id),
      waitingApproval: tasks.listByStatus('WAITING_APPROVAL').length,
      model: selection.model,
      provider: config.provider,
      agentReady: copilot.installed && copilot.authenticatedUser !== null,
      creditsToday: tasks.creditsUsedSince(24 * 60 * 60 * 1000),
      creditsPerDayCap: config.limits.maxAiCreditsPerDay,
      telegramEnabled: config.interfaces.telegram,
    });
  }

  private handleProjects(res: ServerResponse): void {
    this.deps.projects.load();
    // Metadata only: name and detected commands. Paths stay on the PC — the
    // browser has no business knowing the filesystem layout.
    this.json(res, 200, {
      projects: this.deps.projects.enabled().map((p) => ({
        id: p.id,
        name: p.name,
        testCommand: p.testCommand ?? null,
        buildCommand: p.buildCommand ?? null,
      })),
    });
  }

  private async handleAgents(res: ServerResponse): Promise<void> {
    const { config } = this.deps;
    if (!this.providerCache) {
      const entries: Array<Record<string, unknown>> = [];
      for (const id of PROVIDER_IDS) {
        const provider = selectProvider(id);
        let info = this.providerInfoFor(id);
        if (!info) {
          // No startup detection was injected (headless construction): probe once.
          try {
            info = await provider.detect(null);
          } catch {
            info = null;
          }
        }
        entries.push({
          id,
          name: provider.displayName,
          billing: provider.billing,
          active: id === config.provider,
          installed: info?.installed ?? false,
          authenticated: (info?.authenticatedUser ?? null) !== null,
          // Selectable per task: installed and signed in. The runner re-checks.
          selectable: (info?.installed ?? false) && (info?.authenticatedUser ?? null) !== null,
          models: info?.models ?? [],
        });
      }
      this.providerCache = entries;
    }
    this.json(res, 200, { agents: this.providerCache, defaultModel: config.copilot.model });
  }

  /** Detection info for a provider, adapting the injected Copilot info when no map entry exists. */
  private providerInfoFor(id: ProviderId): ProviderInfo | null {
    const known = this.deps.providers?.[id];
    if (known) return known;
    if (id === 'copilot') {
      const c = this.deps.copilot;
      return {
        id: 'copilot',
        installed: c.installed,
        version: c.version,
        launcher: c.launcher,
        models: c.models,
        authenticatedUser: c.authenticatedUser,
        error: c.error ?? null,
      };
    }
    return null;
  }

  private taskJson(task: NonNullable<ReturnType<TaskRepository['get']>>): Record<string, unknown> {
    return {
      id: task.id,
      projectId: task.projectId,
      prompt: task.prompt,
      status: task.status,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      error: task.error,
      commit: task.commitHash,
      branch: task.branch,
      retryCount: task.retryCount,
      approvalStatus: task.approvalStatus,
      approvalReason: task.approvalReason,
      origin: task.origin,
      model: task.model,
      provider: task.provider,
      aiCredits: task.usage.aiCredits,
      files: task.result?.filesChanged ?? [],
      linesAdded: task.result?.linesAdded ?? 0,
      linesRemoved: task.result?.linesRemoved ?? 0,
      testsPassed: task.result?.verifications?.every((v) => v.passed) ?? null,
      // The agent's own final message, stored verbatim (post-redaction) by the
      // runner. The UI must present it as-is — never paraphrased.
      agentMessage: task.result?.summary ?? null,
      verifications: (task.result?.verifications ?? []).map((v) => ({
        kind: v.kind,
        command: v.command,
        passed: v.passed,
        durationMs: v.durationMs,
        output: v.summary,
      })),
    };
  }

  private handleTaskList(url: URL, res: ServerResponse): void {
    const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '30', 10) || 30, 1), 100);
    // Position reflects the claimer's actual order, so what the UI shows is
    // what will happen — not a guess from creation time.
    const positions = new Map(this.deps.tasks.queuedInOrder().map((t, i) => [t.id, i + 1]));
    this.json(res, 200, {
      tasks: this.deps.tasks.list(limit).map((t) => ({
        ...this.taskJson(t),
        queuePosition: positions.get(t.id) ?? null,
      })),
    });
  }

  private handleTaskDetail(id: number, res: ServerResponse): void {
    const task = this.deps.tasks.get(id);
    if (!task) return this.json(res, 404, { error: 'Task not found' });
    const events = this.deps.tasks.events(id, 300).map((e) => ({
      ts: e.ts,
      kind: e.kind,
      message: e.message,
    }));
    this.json(res, 200, { task: this.taskJson(task), events, approvalPending: this.deps.approvals.isPending(id) });
  }

  private async handleTaskDiff(id: number, res: ServerResponse): Promise<void> {
    const task = this.deps.tasks.get(id);
    if (!task) return this.json(res, 404, { error: 'Task not found' });
    if (!task.commitHash) return this.json(res, 200, { diff: null, note: 'This task created no commit.' });

    this.deps.projects.load();
    const project = this.deps.projects.getById(task.projectId);
    if (!project) return this.json(res, 404, { error: 'Project no longer registered' });

    // Only the commit recorded on the task row — the id comes from our own
    // database, never from the client, so this cannot address other history.
    const git = new Git(project.path);
    const result = await git.showCommit(task.commitHash, MAX_DIFF_BYTES);
    if (result === null) return this.json(res, 500, { error: 'Could not read the commit from git' });

    this.json(res, 200, { diff: redact(result) });
  }

  // ------------------------------------------------------------------ writes

  private async handleTaskCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req);
    const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
    const rawPrompt = typeof body?.prompt === 'string' ? body.prompt : '';
    const model = typeof body?.model === 'string' && body.model !== '' ? body.model : null;
    const requestedProvider = typeof body?.provider === 'string' && body.provider !== '' ? body.provider : null;
    const mode = typeof body?.mode === 'string' && body.mode in MODE_DIRECTIVES ? body.mode : 'code';

    if (requestedProvider && !isProviderId(requestedProvider)) {
      return this.json(res, 400, { error: `Unknown agent provider "${requestedProvider}".` });
    }
    const effectiveProvider: ProviderId = isProviderId(requestedProvider ?? '')
      ? (requestedProvider as ProviderId)
      : this.deps.config.provider;
    const info = this.providerInfoFor(effectiveProvider);
    if (requestedProvider && !info?.installed) {
      return this.json(res, 400, { error: `${requestedProvider} is not installed on the PC.` });
    }
    // Validated against the CHOSEN provider's catalogue, not the default's.
    if (model && !(info?.models ?? this.deps.copilot.models).includes(model)) {
      return this.json(res, 400, { error: `Model "${model}" is not offered by the installed CLI.` });
    }

    const result = this.deps.service.submit({
      origin: 'web',
      userId: 0,
      chatId: 0,
      projectId,
      prompt: MODE_DIRECTIVES[mode] + rawPrompt,
      model,
      provider: requestedProvider,
    });
    if (!result.ok) return this.json(res, 400, { error: result.error });
    this.json(res, 201, { task: this.taskJson(result.task), awaitingApproval: result.awaitingApproval });
  }

  private async handleApproval(id: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req);
    const decision = body?.decision === 'APPROVED' ? 'APPROVED' : body?.decision === 'REJECTED' ? 'REJECTED' : null;
    if (!decision) return this.json(res, 400, { error: 'decision must be APPROVED or REJECTED' });

    // The web operator authenticated with the password; on this single-user
    // system that is the same person as the Telegram operator.
    const result = this.deps.approvals.resolve(id, decision);
    if (result === 'not-pending') return this.json(res, 409, { error: 'No pending approval for that task' });
    this.json(res, 200, { ok: true, decision });
  }

  // --------------------------------------------------------------------- SSE

  private handleSse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const lastId = Number.parseInt(String(req.headers['last-event-id'] ?? ''), 10);
    if (!Number.isNaN(lastId)) {
      for (const event of this.deps.bus.since(lastId)) this.writeSse(res, event);
    }

    this.sseClients.add(res);
    req.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  private broadcast(event: BusEvent): void {
    for (const client of this.sseClients) this.writeSse(client, event);
  }

  private writeSse(res: ServerResponse, event: BusEvent): void {
    try {
      res.write(`id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      this.sseClients.delete(res);
    }
  }

  // ------------------------------------------------------------------ static

  private serveStatic(route: string, res: ServerResponse): void {
    const requested = route === '/' ? '/index.html' : route;
    const resolved = path.resolve(this.staticRoot, '.' + path.posix.normalize(requested));

    // Refuse anything that escapes the static root or has an unknown type.
    if (!resolved.startsWith(this.staticRoot + path.sep) && resolved !== path.join(this.staticRoot, 'index.html')) {
      return this.json(res, 404, { error: 'Not found' });
    }
    const type = STATIC_TYPES[path.extname(resolved).toLowerCase()];
    if (!type || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      // SPA: unknown non-file paths get the app shell so deep links work.
      if (!path.extname(requested)) return this.serveStatic('/', res);
      return this.json(res, 404, { error: 'Not found' });
    }

    res.writeHead(200, {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer',
    });
    fs.createReadStream(resolved).pipe(res);
  }

  // ------------------------------------------------------------------- utils

  private readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null);
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
      // A destroyed request emits 'close' without 'end'; the promise must not
      // be left pending, or the handler above it leaks.
      req.on('close', () => resolve(null));
    });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(payload);
  }
}
