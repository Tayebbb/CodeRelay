import { Bot, GrammyError, HttpError, InlineKeyboard } from 'grammy';
import type { AppConfig } from '../core/config.js';
import { createLogger, errorMessage } from '../core/logger.js';
import { redact } from '../core/redact.js';
import type { TaskRepository } from '../db/taskRepository.js';
import type { ProjectRegistry } from '../projects/registry.js';
import type { TaskQueue } from '../runner/queue.js';
import type { TaskRunner } from '../runner/taskRunner.js';
import type { ApprovalService } from '../approval/service.js';
import type { TaskService } from '../core/taskService.js';
import { GIT_ACTIONS, isGitAction, type GitControlService } from '../core/gitControl.js';
import type { ApprovalRequest, Notifier } from '../notify/notifier.js';
import type { CopilotInfo } from '../copilot/detect.js';
import { selectModel } from '../copilot/detect.js';
import { authorize, UnauthorizedThrottle } from './auth.js';
import { parseNaturalTask, splitTaskCommand } from './nlp.js';
import {
  clampMessage,
  formatDuration,
  formatProjectList,
  formatTaskLine,
  HELP_TEXT,
  truncate,
} from './format.js';

const log = createLogger('telegram');

export type ConnectionState = 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';

export interface TelegramBotDeps {
  config: AppConfig;
  tasks: TaskRepository;
  projects: ProjectRegistry;
  queue: TaskQueue;
  runner: TaskRunner;
  approvals: ApprovalService;
  service: TaskService;
  gitControl: GitControlService;
  copilot: CopilotInfo;
  startedAt: number;
}

/** Bound on outbox pages per flush, so a huge backlog cannot spin forever. */
const MAX_OUTBOX_PAGES = 50;

export class TelegramBot implements Notifier {
  private readonly bot: Bot;
  private readonly throttle = new UnauthorizedThrottle();
  private connection: ConnectionState = 'DISCONNECTED';
  private lastActivityAt = 0;
  private lastApiOkAt = 0;
  private healthTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private flushing = false;

  constructor(private readonly deps: TelegramBotDeps) {
    this.bot = new Bot(deps.config.telegram.botToken);
    this.registerMiddleware();
    this.registerCommands();
    this.registerCallbacks();
    this.registerFallback();

    this.bot.catch((err) => {
      const e = err.error;
      if (e instanceof GrammyError) {
        log.error('Telegram API error', { description: redact(e.description) });
      } else if (e instanceof HttpError) {
        this.connection = 'RECONNECTING';
        log.warn('Telegram network error; grammY will retry', { error: errorMessage(e) });
      } else {
        log.error('Bot handler error', { error: errorMessage(e) });
      }
    });
  }

  // ---------------------------------------------------------------- Notifier

  async sendMessage(chatId: number, text: string): Promise<void> {
    const body = clampMessage(redact(text));
    try {
      await this.bot.api.sendMessage(chatId, body, { link_preview_options: { is_disabled: true } });
      this.lastApiOkAt = Date.now();
      this.connection = 'CONNECTED';
      void this.flushOutbox();
    } catch (err) {
      // A task can finish while Telegram is unreachable. Keep the message so the
      // operator still learns the outcome instead of silently losing it.
      if (this.isTransient(err)) {
        this.connection = 'RECONNECTING';
        try {
          this.deps.tasks.enqueueOutbox(chatId, body);
        } catch (dbErr) {
          log.error('Could not queue an undelivered message', { error: errorMessage(dbErr) });
        }
      }
      log.warn('Could not deliver message', { chatId, error: errorMessage(err) });
    }
  }

  /** Network trouble is worth retrying; a rejected payload is not. */
  private isTransient(err: unknown): boolean {
    if (err instanceof GrammyError) return err.error_code === 429 || err.error_code >= 500;
    return true;
  }

  /** Deliver anything queued while Telegram was unreachable. */
  private async flushOutbox(): Promise<void> {
    if (this.flushing || this.stopping) return;
    this.flushing = true;
    try {
      // Keep going until the queue is empty. `pendingOutbox()` returns a page,
      // and a single page was not enough: after a long outage the message that
      // actually matters (the final report) sits behind a hundred progress
      // pings and was never reached, because nothing re-triggered the flush.
      for (let page = 0; page < MAX_OUTBOX_PAGES; page += 1) {
        const batch = this.deps.tasks.pendingOutbox();
        if (batch.length === 0) return;

        let delivered = 0;
        for (const message of batch) {
          if (this.stopping) return;
          try {
            await this.bot.api.sendMessage(message.chatId, message.body, {
              link_preview_options: { is_disabled: true },
            });
            this.deps.tasks.dropOutbox(message.id);
            delivered += 1;
          } catch (err) {
            this.deps.tasks.failOutboxAttempt(message.id);
            log.warn('Outbox delivery failed; will retry', { error: errorMessage(err) });
            return;
          }
        }
        if (delivered === 0) return;
      }
    } catch (err) {
      log.error('Outbox flush failed', { error: errorMessage(err) });
    } finally {
      this.flushing = false;
    }
  }

  async requestApproval(request: ApprovalRequest): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text('✅ APPROVE', `approve:${request.taskId}`)
      .text('❌ REJECT', `reject:${request.taskId}`);

    const body = [
      '⚠️ Approval required',
      '',
      `Task: #${request.taskId}`,
      `Project: ${request.project}`,
      `Operation: ${request.title}`,
      `Reason: ${request.reason}`,
      request.details.length > 0 ? '' : null,
      request.details.length > 0 ? 'Details:' : null,
      ...request.details.slice(0, 15).map((d) => `  ${d}`),
      '',
      `This expires in ${Math.round(this.deps.config.limits.approvalTimeoutMs / 60_000)} minutes.`,
    ]
      .filter((l) => l !== null)
      .join('\n');

    try {
      await this.bot.api.sendMessage(request.chatId, clampMessage(redact(body)), { reply_markup: keyboard });
    } catch (err) {
      log.error('Could not deliver approval request', { taskId: request.taskId, error: errorMessage(err) });
      // Rethrow: a card nobody received cannot be answered, and silently
      // returning left the task holding the only queue slot for the full
      // approval timeout (an hour by default) waiting for a tap that could
      // never come. The caller treats this as "not approved" immediately.
      throw err;
    }
  }

  // ---------------------------------------------------------------- lifecycle

  async start(options: { onReady?: () => void } = {}): Promise<void> {
    // A logon-triggered start often races the network coming up, so a transient
    // failure must not kill the process into a restart loop. A 401 is fatal and
    // is reported as such rather than retried forever.
    const me = await this.callWithRetry(() => this.bot.api.getMe());
    this.connection = 'CONNECTED';
    this.lastApiOkAt = Date.now();
    log.info('Telegram bot online', { username: me.username });

    this.healthTimer = setInterval(() => this.evaluateHealth(), 30_000);
    this.healthTimer.unref?.();

    await this.bot.start({
      // Long polling: the PC dials out. No inbound port, no public endpoint.
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
      onStart: () => {
        this.connection = 'CONNECTED';
        this.lastApiOkAt = Date.now();
        void this.flushOutbox();
        options.onReady?.();
      },
    });
  }

  /** Retry transient Telegram failures with backoff; surface fatal ones. */
  private async callWithRetry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
    let delay = 2_000;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        const fatal =
          err instanceof GrammyError && (err.error_code === 401 || err.error_code === 403 || err.error_code === 409);
        if (fatal) {
          log.error('Telegram rejected the bot token or another instance is polling', {
            error: redact(err.description),
          });
          throw err;
        }
        if (attempt >= attempts) throw err;
        this.connection = 'RECONNECTING';
        log.warn('Telegram unreachable; retrying', { attempt, delayMs: delay, error: errorMessage(err) });
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }

  /**
   * grammY retries polling failures internally and does not surface them, so
   * without this the reported state would always read CONNECTED during an
   * outage. Silence beyond the threshold is treated as a lost connection and
   * confirmed with a cheap API call.
   */
  private evaluateHealth(): void {
    if (this.stopping) return;
    const quietFor = Date.now() - Math.max(this.lastApiOkAt, this.lastActivityAt);
    if (quietFor < 120_000) return;

    void this.bot.api
      .getMe()
      .then(() => {
        this.lastApiOkAt = Date.now();
        if (this.connection !== 'CONNECTED') {
          log.info('Telegram connection restored');
          void this.flushOutbox();
        }
        this.connection = 'CONNECTED';
      })
      .catch((err) => {
        if (this.connection === 'CONNECTED') {
          log.warn('Telegram connection lost; grammY will keep retrying', { error: errorMessage(err) });
        }
        this.connection = 'RECONNECTING';
      });
  }

  /**
   * Stop accepting updates. Called first during shutdown so no new task or
   * approval can be created while in-flight work is being drained.
   */
  async stopAcceptingUpdates(): Promise<void> {
    this.stopping = true;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.connection = 'DISCONNECTED';
    await this.bot.stop();
  }

  /** Let detached approval flows finish writing, bounded so shutdown cannot hang. */
  async drainApprovalFlows(graceMs = 5_000): Promise<void> {
    // Approval flows live in the shared TaskService now; bounded there too.
    await Promise.race([
      this.deps.service.drain(),
      new Promise((resolve) => setTimeout(resolve, graceMs).unref?.()),
    ]);
  }

  async stop(): Promise<void> {
    await this.stopAcceptingUpdates();
    await this.drainApprovalFlows();
  }

  connectionState(): ConnectionState {
    return this.connection;
  }

  /** Milliseconds since the last confirmed contact with Telegram. */
  quietForMs(): number {
    const last = Math.max(this.lastApiOkAt, this.lastActivityAt);
    return last === 0 ? 0 : Date.now() - last;
  }

  async notifyOperators(text: string): Promise<void> {
    for (const userId of this.deps.config.telegram.authorizedUserIds) {
      await this.sendMessage(userId, text);
    }
  }

  // ---------------------------------------------------------------- internals

  private registerMiddleware(): void {
    this.bot.use(async (ctx, next) => {
      const decision = authorize(ctx.from?.id, this.deps.config.telegram.authorizedUserIds);

      if (!decision.allowed) {
        // Logging every stranger's message would let anyone who knows the bot
        // username fill the disk, so the log is throttled with the reply.
        const shouldReport = ctx.from?.id !== undefined && this.throttle.shouldRespond(ctx.from.id);
        if (shouldReport) {
          log.warn('Rejected unauthorized Telegram request', {
            userId: ctx.from?.id ?? null,
            username: ctx.from?.username ?? null,
          });
          // Say nothing useful: no project names, no status, no hint that this
          // is a control channel for a real machine.
          await ctx.reply('This bot is private.').catch(() => {});
        }
        return;
      }

      this.lastActivityAt = Date.now();

      // Authorisation is per-user, but delivery is per-CHAT. In a group, every
      // progress update, diff excerpt and approval card would be readable by
      // every member, even though only the operator can issue commands.
      const chatType = ctx.chat?.type;
      if (chatType && chatType !== 'private') {
        log.warn('Refused to operate in a non-private chat', { chatType, chatId: ctx.chat?.id ?? null });
        await ctx
          .reply('This bot only works in a direct message, because it reports file contents and diffs.')
          .catch(() => {});
        return;
      }

      // Idempotency: a redelivered update must never enqueue a task twice.
      if (ctx.update.update_id !== undefined && !this.deps.tasks.markUpdateProcessed(ctx.update.update_id)) {
        log.debug('Dropped duplicate update', { updateId: ctx.update.update_id });
        return;
      }

      this.connection = 'CONNECTED';
      await next();
    });
  }

  private registerCommands(): void {
    const { tasks, projects, queue, config, copilot } = this.deps;

    this.bot.command('start', (ctx) => ctx.reply(HELP_TEXT));
    this.bot.command('help', (ctx) => ctx.reply(HELP_TEXT));

    this.bot.command('projects', async (ctx) => {
      projects.load();
      await ctx.reply(formatProjectList(projects.enabled()));
    });

    this.bot.command('status', async (ctx) => {
      const active = queue.activeIds();
      const queuedTasks = tasks.queuedInOrder();
      const waiting = tasks.listByStatus('WAITING_APPROVAL').length;
      const selection = selectModel(config.copilot.model, config.copilot.modelFallback, copilot.models);
      const dailyUsed = tasks.creditsUsedSince(24 * 60 * 60 * 1000);

      const lines = [
        '🖥 Agent status',
        '',
        `Connection: ${this.connection}${this.connection !== 'CONNECTED' ? ` (quiet for ${formatDuration(this.quietForMs())})` : ''}`,
        `Uptime: ${formatDuration(Date.now() - this.deps.startedAt)}`,
        `Copilot CLI: ${copilot.installed ? `v${copilot.version}` : 'NOT INSTALLED'}`,
        `Copilot account: ${copilot.authenticatedUser ?? 'not signed in'}`,
        `Model: ${selection.model}${selection.fellBack ? ` (fallback from ${selection.requested})` : ''}`,
        `Sandbox: ${config.copilot.sandbox ? 'on (experimental)' : 'off'}`,
        '',
        `Current: ${active.length > 0 ? active.map((id) => `#${id}`).join(', ') : 'idle'}`,
        `Queue: ${queuedTasks.length > 0 ? queuedTasks.map((t) => `#${t.id}`).join(' → ') : 'empty'}`,
        `Awaiting approval: ${waiting}`,
        '',
        `AI credits (24h): ${dailyUsed.toFixed(2)}${config.limits.maxAiCreditsPerDay > 0 ? ` / ${config.limits.maxAiCreditsPerDay}` : ''}`,
        `Per-task budget: ${config.limits.maxAiCreditsPerTask || 'unlimited (not recommended)'}`,
        `Auto-commit: ${config.git.autoCommit ? 'on' : 'off'} · Auto-push: ${config.git.autoPush ? 'on (with approval)' : 'off'}`,
      ];
      if (selection.note) lines.push('', `⚠️ ${selection.note}`);
      await ctx.reply(clampMessage(lines.join('\n')));
    });

    this.bot.command('usage', async (ctx) => {
      const day = tasks.creditsUsedSince(24 * 60 * 60 * 1000);
      const week = tasks.creditsUsedSince(7 * 24 * 60 * 60 * 1000);
      await ctx.reply(
        [
          '💳 Copilot AI usage (as reported by the CLI)',
          '',
          `Last 24h: ${day.toFixed(2)} credits`,
          `Last 7d:  ${week.toFixed(2)} credits`,
          '',
          `Per-task cap:  ${config.limits.maxAiCreditsPerTask || 'disabled'}`,
          `Per-day cap:   ${config.limits.maxAiCreditsPerDay || 'disabled'}`,
          '',
          'This application never purchases credits and never changes billing settings.',
          'Figures come from the Copilot CLI result payload and cover tasks run through this agent only.',
        ].join('\n'),
      );
    });

    this.bot.command('tasks', async (ctx) => {
      const limit = Math.min(Math.max(Number.parseInt(ctx.match || '10', 10) || 10, 1), 30);
      const recent = tasks.list(limit);
      if (recent.length === 0) return void (await ctx.reply('No tasks yet.'));
      const lines = recent.map((task) => {
        const project = projects.getById(task.projectId);
        return formatTaskLine(task, project?.name ?? task.projectId);
      });
      await ctx.reply(clampMessage(['Recent tasks:', '', ...lines].join('\n')));
    });

    this.bot.command('logs', async (ctx) => {
      const id = Number.parseInt(ctx.match ?? '', 10);
      if (Number.isNaN(id)) return void (await ctx.reply('Usage: /logs <task id>'));
      const task = tasks.get(id);
      if (!task) return void (await ctx.reply(`Task #${id} not found.`));

      const events = tasks.events(id, 60);
      const lines = events.map((e) => `${new Date(e.ts).toLocaleTimeString()} [${e.kind}] ${truncate(e.message, 160)}`);
      await ctx.reply(clampMessage([`Log for task #${id} (${task.status}):`, '', ...lines].join('\n')));
    });

    this.bot.command('cancel', async (ctx) => {
      const id = Number.parseInt(ctx.match ?? '', 10);
      if (Number.isNaN(id)) return void (await ctx.reply('Usage: /cancel <task id>'));
      const result = this.deps.service.cancel(id, ctx.from?.id);
      await ctx.reply(result.ok ? `🚫 ${result.message}` : result.error);
    });

    this.bot.command('retry', async (ctx) => {
      const id = Number.parseInt(ctx.match ?? '', 10);
      if (Number.isNaN(id)) return void (await ctx.reply('Usage: /retry <task id>'));
      const result = this.deps.service.retry(id);
      await ctx.reply(result.ok ? `🔁 ${result.message}` : result.error);
    });

    this.bot.command('followup', async (ctx) => {
      const match = /^(\d+)\s+([\s\S]+)$/.exec((ctx.match ?? '').trim());
      if (!match) {
        return void (await ctx.reply('Usage: /followup <task id> <what to do next>\n\nContinues that task\u2019s agent session instead of starting cold.'));
      }
      const result = this.deps.service.followUp(Number.parseInt(match[1]!, 10), {
        origin: 'telegram',
        userId: ctx.from?.id ?? 0,
        chatId: ctx.chat.id,
        prompt: match[2]!,
      });
      if (!result.ok) return void (await ctx.reply(result.error));
      await ctx.reply(
        result.awaitingApproval
          ? `⚠️ Task #${result.task.id} needs approval before it runs (follows #${match[1]}).`
          : `↩️ Task #${result.task.id} queued — continues the agent session of #${match[1]}.`,
      );
    });

    this.bot.command('approve', async (ctx) => this.decide(ctx.match ?? '', 'APPROVED', ctx));
    this.bot.command('reject', async (ctx) => this.decide(ctx.match ?? '', 'REJECTED', ctx));

    // /git [project] [status|fetch|pull|push|sync] — the git remote control.
    this.bot.command('git', async (ctx) => {
      const usage = 'Usage: /git [project] <status|fetch|pull|push|sync>';
      const tokens = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
      projects.load();

      let action = 'status';
      const last = tokens.at(-1)?.toLowerCase() ?? '';
      if (last === 'status' || isGitAction(last)) {
        action = last;
        tokens.pop();
      }

      const selector = tokens.join(' ');
      let projectId: string | null = null;
      if (selector) {
        const resolved = projects.resolve(selector);
        if (!resolved) return void (await ctx.reply(`No registered project matches "${truncate(selector, 40)}".`));
        if ('ambiguous' in resolved) {
          const names = resolved.ambiguous.map((p) => `  - ${p.name} (${p.id})`).join('\n');
          return void (await ctx.reply(`"${truncate(selector, 40)}" matches several projects:\n${names}`));
        }
        projectId = resolved.project.id;
      } else {
        const enabled = projects.enabled();
        if (enabled.length === 1) projectId = enabled[0]!.id;
        else return void (await ctx.reply(`${usage}\n\n${formatProjectList(enabled)}`));
      }

      if (action === 'status') {
        const panel = await this.deps.gitControl.status(projectId);
        if (!panel) return void (await ctx.reply('That project is not registered.'));
        if (!panel.isRepo) return void (await ctx.reply('This project is not a git repository.'));
        const lines = [
          `Git — ${projectId}`,
          `Branch: ${panel.branch ?? 'detached'}`,
          `Ahead ${panel.ahead} · behind ${panel.behind}${panel.hasRemote ? '' : ' (no remote)'}`,
          panel.dirty > 0 ? `${panel.dirty} uncommitted change(s)` : 'Working tree clean',
        ];
        if (panel.error) lines.push(`⚠️ ${panel.error}`);
        lines.push('', `Actions: /git ${projectId} ${GIT_ACTIONS.join(' | ')}`);
        return void (await ctx.reply(lines.join('\n')));
      }

      const result = await this.deps.gitControl.run(projectId, action as (typeof GIT_ACTIONS)[number]);
      await ctx.reply(`${result.ok ? '✅' : '⚠️'} ${result.message}`);
    });

    this.bot.command('task', async (ctx) => {
      const parts = splitTaskCommand(ctx.match ?? '');
      if (!parts) {
        return void (await ctx.reply('Usage: /task <project> <what to do>\n\nSee /projects for the list.'));
      }
      projects.load();
      const resolved = projects.resolve(parts.selector);

      if (!resolved) {
        return void (await ctx.reply(
          `No registered project matches "${truncate(parts.selector, 40)}".\n\n${formatProjectList(projects.enabled())}`,
        ));
      }
      if ('ambiguous' in resolved) {
        const names = resolved.ambiguous.map((p) => `  - ${p.name} (${p.id})`).join('\n');
        return void (await ctx.reply(`"${truncate(parts.selector, 40)}" matches several projects:\n${names}`));
      }
      await this.enqueue(ctx, resolved.project.id, parts.prompt);
    });
  }

  private registerCallbacks(): void {
    this.bot.on('callback_query:data', async (ctx) => {
      // Telegram shows a spinner until answerCallbackQuery runs, so it must
      // happen on every path including failures.
      let note = 'Done';
      try {
        const data = ctx.callbackQuery.data;
        const match = /^(approve|reject):(\d+)$/.exec(data);
        if (!match) return void (await ctx.answerCallbackQuery());

        const decision = match[1] === 'approve' ? 'APPROVED' : 'REJECTED';
        const taskId = Number.parseInt(match[2]!, 10);
        const result = this.deps.approvals.resolve(taskId, decision, ctx.from?.id);

        note =
          result === 'resolved'
            ? `Task #${taskId}: ${decision}`
            : result === 'forbidden'
              ? `Task #${taskId} belongs to another operator`
              : `No pending request for #${taskId}`;

        await ctx.answerCallbackQuery({ text: note });

        if (result === 'resolved') {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          await ctx
            .reply(`${decision === 'APPROVED' ? '✅' : '❌'} Task #${taskId} ${decision.toLowerCase()}.`)
            .catch(() => {});
        }
      } catch (err) {
        log.error('Callback handling failed', { error: errorMessage(err) });
        await ctx.answerCallbackQuery({ text: 'Something went wrong.' }).catch(() => {});
      }
    });
  }

  private registerFallback(): void {
    // Free-form text: try to identify the project locally, no model call.
    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text.trim();
      if (text.startsWith('/')) return void (await ctx.reply(`Unknown command.\n\n${HELP_TEXT}`));

      this.deps.projects.load();
      const enabled = this.deps.projects.enabled();
      const parsed = parseNaturalTask(text, enabled);

      if (parsed.projectId) {
        await ctx.reply(`Interpreted as a task for: ${parsed.matchedOn}`);
        return void (await this.enqueue(ctx, parsed.projectId, parsed.prompt));
      }
      if (parsed.candidates.length > 0) {
        const names = parsed.candidates.map((p, i) => `  ${i + 1}. ${p.name}`).join('\n');
        return void (await ctx.reply(`Which project did you mean?\n${names}\n\nUse: /task <number> ${truncate(text, 60)}`));
      }
      await ctx.reply(
        `I could not tell which project you mean.\n\n${formatProjectList(enabled)}`,
      );
    });
  }

  private async decide(
    raw: string,
    decision: 'APPROVED' | 'REJECTED',
    ctx: { from?: { id: number }; reply: (t: string) => Promise<unknown> },
  ) {
    const id = Number.parseInt(raw, 10);
    if (Number.isNaN(id)) {
      return void (await ctx.reply(`Usage: /${decision === 'APPROVED' ? 'approve' : 'reject'} <task id>`));
    }
    const result = this.deps.approvals.resolve(id, decision, ctx.from?.id);
    await ctx.reply(
      result === 'resolved'
        ? `Task #${id}: ${decision}.`
        : result === 'forbidden'
          ? `Task #${id} belongs to another operator.`
          : `No pending approval for task #${id}.`,
    );
  }

  private async enqueue(
    ctx: { from?: { id: number }; chat: { id: number }; reply: (t: string) => Promise<unknown> },
    projectId: string,
    prompt: string,
  ): Promise<void> {
    const project = this.deps.projects.getById(projectId);
    const result = this.deps.service.submit({
      origin: 'telegram',
      userId: ctx.from?.id ?? 0,
      chatId: ctx.chat.id,
      projectId,
      prompt,
    });

    if (!result.ok) return void (await ctx.reply(result.error));
    const name = project?.name ?? projectId;
    await ctx.reply(
      result.awaitingApproval
        ? `Task #${result.task.id} queued for ${name} — approval required.`
        : `✅ Task #${result.task.id} queued for ${name}.`,
    );
  }
}
