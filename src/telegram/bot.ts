import { Bot, GrammyError, HttpError, InlineKeyboard } from 'grammy';
import type { AppConfig } from '../core/config.js';
import { createLogger, errorMessage } from '../core/logger.js';
import { redact } from '../core/redact.js';
import type { TaskRepository } from '../db/taskRepository.js';
import type { ProjectRegistry } from '../projects/registry.js';
import type { TaskQueue } from '../runner/queue.js';
import type { TaskRunner } from '../runner/taskRunner.js';
import type { ApprovalService } from '../approval/service.js';
import { assessRisk } from '../approval/risk.js';
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
import { isTerminal } from '../domain/task.js';

const log = createLogger('telegram');

export type ConnectionState = 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';

export interface TelegramBotDeps {
  config: AppConfig;
  tasks: TaskRepository;
  projects: ProjectRegistry;
  queue: TaskQueue;
  runner: TaskRunner;
  approvals: ApprovalService;
  copilot: CopilotInfo;
  startedAt: number;
}

const MAX_PROMPT_LENGTH = 4000;

export class TelegramBot implements Notifier {
  private readonly bot: Bot;
  private readonly throttle = new UnauthorizedThrottle();
  private connection: ConnectionState = 'DISCONNECTED';

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
    try {
      await this.bot.api.sendMessage(chatId, clampMessage(redact(text)), {
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      log.warn('Could not deliver message', { chatId, error: errorMessage(err) });
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
    }
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    const me = await this.bot.api.getMe();
    this.connection = 'CONNECTED';
    log.info('Telegram bot online', { username: me.username });

    await this.bot.start({
      // Long polling: the PC dials out. No inbound port, no public endpoint.
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
      onStart: () => {
        this.connection = 'CONNECTED';
      },
    });
  }

  async stop(): Promise<void> {
    this.connection = 'DISCONNECTED';
    await this.bot.stop();
  }

  connectionState(): ConnectionState {
    return this.connection;
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
        log.warn('Rejected unauthorized Telegram request', {
          userId: ctx.from?.id ?? null,
          username: ctx.from?.username ?? null,
        });
        // Say nothing useful: no project names, no status, no hint that this is
        // a control channel for a real machine.
        if (ctx.from?.id && this.throttle.shouldRespond(ctx.from.id)) {
          await ctx.reply('This bot is private.').catch(() => {});
        }
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
    const { tasks, projects, queue, runner, approvals, config, copilot } = this.deps;

    this.bot.command('start', (ctx) => ctx.reply(HELP_TEXT));
    this.bot.command('help', (ctx) => ctx.reply(HELP_TEXT));

    this.bot.command('projects', async (ctx) => {
      projects.load();
      await ctx.reply(formatProjectList(projects.enabled()));
    });

    this.bot.command('status', async (ctx) => {
      const active = queue.activeIds();
      const queued = tasks.listByStatus('QUEUED').length;
      const waiting = tasks.listByStatus('WAITING_APPROVAL').length;
      const selection = selectModel(config.copilot.model, config.copilot.modelFallback, copilot.models);
      const dailyUsed = tasks.creditsUsedSince(24 * 60 * 60 * 1000);

      const lines = [
        '🖥 Agent status',
        '',
        `Connection: ${this.connection}`,
        `Uptime: ${formatDuration(Date.now() - this.deps.startedAt)}`,
        `Copilot CLI: ${copilot.installed ? `v${copilot.version}` : 'NOT INSTALLED'}`,
        `Copilot account: ${copilot.authenticatedUser ?? 'not signed in'}`,
        `Model: ${selection.model}${selection.fellBack ? ` (fallback from ${selection.requested})` : ''}`,
        '',
        `Running: ${active.length > 0 ? active.map((id) => `#${id}`).join(', ') : 'none'}`,
        `Queued: ${queued}`,
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
      const task = tasks.get(id);
      if (!task) return void (await ctx.reply(`Task #${id} not found.`));
      if (isTerminal(task.status)) return void (await ctx.reply(`Task #${id} already finished (${task.status}).`));

      if (runner.isRunning(id)) {
        runner.cancel(id);
        await ctx.reply(`🚫 Cancelling task #${id}…`);
      } else {
        tasks.transition(id, 'CANCELLED', { error: 'Cancelled by operator before execution.' });
        approvals.resolve(id, 'REJECTED');
        await ctx.reply(`🚫 Task #${id} cancelled.`);
      }
    });

    this.bot.command('retry', async (ctx) => {
      const id = Number.parseInt(ctx.match ?? '', 10);
      if (Number.isNaN(id)) return void (await ctx.reply('Usage: /retry <task id>'));
      const task = tasks.get(id);
      if (!task) return void (await ctx.reply(`Task #${id} not found.`));
      if (!isTerminal(task.status)) return void (await ctx.reply(`Task #${id} is still ${task.status}.`));

      const created = tasks.create({
        userId: task.userId,
        chatId: task.chatId,
        projectId: task.projectId,
        prompt: task.prompt,
        approvalRequired: false,
        approvalReason: null,
      });
      tasks.addEvent(created.id, 'retry', `Re-queued from task #${id}`);
      queue.kick();
      await ctx.reply(`🔁 Re-queued as task #${created.id}.`);
    });

    this.bot.command('approve', async (ctx) => this.decide(ctx.match ?? '', 'APPROVED', ctx));
    this.bot.command('reject', async (ctx) => this.decide(ctx.match ?? '', 'REJECTED', ctx));

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
      const data = ctx.callbackQuery.data;
      const match = /^(approve|reject):(\d+)$/.exec(data);
      if (!match) return void (await ctx.answerCallbackQuery());

      const decision = match[1] === 'approve' ? 'APPROVED' : 'REJECTED';
      const taskId = Number.parseInt(match[2]!, 10);
      const handled = this.deps.approvals.resolve(taskId, decision);

      await ctx.answerCallbackQuery({
        text: handled ? `Task #${taskId}: ${decision}` : `No pending request for #${taskId}`,
      });
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        await ctx.reply(`${decision === 'APPROVED' ? '✅' : '❌'} Task #${taskId} ${decision.toLowerCase()}.`);
      } catch {
        // The original message may be gone; the decision is already recorded.
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

  private async decide(raw: string, decision: 'APPROVED' | 'REJECTED', ctx: { reply: (t: string) => Promise<unknown> }) {
    const id = Number.parseInt(raw, 10);
    if (Number.isNaN(id)) return void (await ctx.reply(`Usage: /${decision === 'APPROVED' ? 'approve' : 'reject'} <task id>`));
    const handled = this.deps.approvals.resolve(id, decision);
    await ctx.reply(handled ? `Task #${id}: ${decision}.` : `No pending approval for task #${id}.`);
  }

  private async enqueue(
    ctx: { from?: { id: number }; chat: { id: number }; reply: (t: string) => Promise<unknown> },
    projectId: string,
    prompt: string,
  ): Promise<void> {
    const { tasks, config, queue, projects } = this.deps;

    if (prompt.length > MAX_PROMPT_LENGTH) {
      return void (await ctx.reply(`That task description is too long (max ${MAX_PROMPT_LENGTH} characters).`));
    }
    const project = projects.getById(projectId);
    if (!project) return void (await ctx.reply('That project is no longer registered.'));

    const risk = assessRisk(prompt);
    const needsApproval = config.safety.requireApprovalForDangerousActions && risk.level === 'elevated';

    const task = tasks.create({
      userId: ctx.from?.id ?? 0,
      chatId: ctx.chat.id,
      projectId,
      prompt,
      approvalRequired: needsApproval,
      approvalReason: risk.reason,
    });

    if (needsApproval) {
      await ctx.reply(`Task #${task.id} queued for ${project.name} — approval required.`);
      const outcome = await this.deps.approvals.request({
        taskId: task.id,
        chatId: ctx.chat.id,
        title: 'Potentially sensitive task',
        project: project.name,
        reason: risk.reason ?? 'Flagged by the risk classifier',
        details: [`Request: ${truncate(prompt, 300)}`],
      });

      if (outcome !== 'APPROVED') {
        tasks.transition(task.id, 'CANCELLED', {
          error: outcome === 'REJECTED' ? 'Rejected by operator.' : 'Approval expired.',
        });
        await this.sendMessage(ctx.chat.id, `🚫 Task #${task.id} ${outcome.toLowerCase()} — nothing was executed.`);
        return;
      }
      tasks.transition(task.id, 'QUEUED');
    } else {
      await ctx.reply(`✅ Task #${task.id} queued for ${project.name}.`);
    }

    queue.kick();
  }
}
