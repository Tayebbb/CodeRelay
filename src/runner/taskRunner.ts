import path from 'node:path';
import fs from 'node:fs';
import type { AppConfig } from '../core/config.js';
import { createLogger, errorMessage } from '../core/logger.js';
import { isSensitiveFile, redact } from '../core/redact.js';
import type { TaskRepository } from '../db/taskRepository.js';
import type { Task, TaskResultDetail, TaskUsage, VerificationResult } from '../domain/task.js';
import { EMPTY_USAGE } from '../domain/task.js';
import type { ProjectRecord, ProjectRegistry } from '../projects/registry.js';
import { Git } from '../git/git.js';
import { detectCommands, type DetectedCommand } from '../verify/detector.js';
import { execCommand, tailLines } from '../util/exec.js';
import { buildPermissionPolicy } from '../copilot/permissions.js';
import { runCopilot, type CopilotRunResult } from '../copilot/executor.js';
import type { CopilotInfo } from '../copilot/detect.js';
import { selectModel } from '../copilot/detect.js';
import { ProgressReporter, type Notifier } from '../notify/notifier.js';
import type { ApprovalService } from '../approval/service.js';
import { buildTaskPrompt } from './promptBuilder.js';
import { formatReport } from '../telegram/format.js';

const log = createLogger('runner');

export interface TaskRunnerDeps {
  config: AppConfig;
  tasks: TaskRepository;
  projects: ProjectRegistry;
  notifier: Notifier;
  approvals: ApprovalService;
  copilot: CopilotInfo;
}

export interface RunOutcome {
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
  message: string;
}

export class TaskRunner {
  private readonly cancellations = new Map<number, AbortController>();

  constructor(private readonly deps: TaskRunnerDeps) {}

  cancel(taskId: number): boolean {
    const controller = this.cancellations.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  isRunning(taskId: number): boolean {
    return this.cancellations.has(taskId);
  }

  async run(task: Task): Promise<RunOutcome> {
    const { config, tasks, projects, notifier, approvals, copilot } = this.deps;
    const controller = new AbortController();
    this.cancellations.set(task.id, controller);

    const reporter = new ProgressReporter({ chatId: task.chatId, taskId: task.id, notifier });
    const startedAt = Date.now();
    const usage: TaskUsage = { ...EMPTY_USAGE, copilotSessionIds: [] };
    const verifications: VerificationResult[] = [];
    let checkpointRef: string | undefined;

    const fail = async (message: string, status: RunOutcome['status'] = 'FAILED'): Promise<RunOutcome> => {
      tasks.transition(task.id, status, { error: message, usage });
      await reporter.close();
      await notifier.sendMessage(task.chatId, `${status === 'CANCELLED' ? '🚫' : '❌'} Task #${task.id}\n\n${message}`);
      return { status, message };
    };

    try {
      const project = projects.getById(task.projectId);
      if (!project) return await fail(`Project "${task.projectId}" is no longer registered.`);
      if (!fs.existsSync(project.path)) {
        return await fail(`Project path no longer exists: ${project.path}`);
      }

      // ---- Cost guard: daily budget ------------------------------------------------
      if (config.limits.maxAiCreditsPerDay > 0) {
        const used = tasks.creditsUsedSince(24 * 60 * 60 * 1000);
        if (used >= config.limits.maxAiCreditsPerDay) {
          return await fail(
            `Daily AI credit budget reached (${used.toFixed(2)} / ${config.limits.maxAiCreditsPerDay}). ` +
              `No Copilot call was made. Raise MAX_AI_CREDITS_PER_DAY or wait for the 24h window to roll over.`,
          );
        }
      }

      // ---- Model selection ---------------------------------------------------------
      const selection = selectModel(config.copilot.model, config.copilot.modelFallback, copilot.models);
      if (!selection.available && !selection.fellBack) {
        return await fail(
          `Configured model is unavailable.\n${selection.note}\n\n` +
            `Set COPILOT_MODEL to a supported id (see /doctor) or set COPILOT_MODEL_FALLBACK.`,
        );
      }
      if (selection.note) {
        tasks.addEvent(task.id, 'model', selection.note);
      }

      await notifier.sendMessage(
        task.chatId,
        [
          `▶️ Task #${task.id} started`,
          '',
          `Project: ${project.name}`,
          `Model: ${selection.model}${selection.fellBack ? ` (fallback from ${selection.requested})` : ''}`,
          `Engine: GitHub Copilot CLI ${copilot.version ?? ''}`.trim(),
          '',
          'Status: inspecting repository…',
        ].join('\n'),
      );

      // ---- Git safety --------------------------------------------------------------
      const git = new Git(project.path);
      const isRepo = await git.isRepository();
      const status = isRepo ? await git.status() : null;
      const branch = status?.branch ?? null;
      const baseCommit = status?.head ?? null;

      if (isRepo && status && !status.clean) {
        const dirtyCount = status.staged.length + status.modified.length + status.untracked.length;
        tasks.addEvent(task.id, 'git', `Repository has ${dirtyCount} uncommitted change(s)`);

        if (config.git.requireApprovalWhenDirty) {
          reporter.update('⚠️ Uncommitted changes detected — asking for approval…');
          const outcome = await approvals.request({
            taskId: task.id,
            chatId: task.chatId,
            title: 'Uncommitted changes present',
            project: project.name,
            reason: `${dirtyCount} uncommitted file(s) in ${project.name}. The agent may modify them.`,
            details: [
              ...status.modified.slice(0, 8).map((f) => `M ${f}`),
              ...status.untracked.slice(0, 8).map((f) => `? ${f}`),
              dirtyCount > 16 ? `…and ${dirtyCount - 16} more` : '',
            ].filter(Boolean),
          });
          if (outcome !== 'APPROVED') {
            return await fail(
              outcome === 'REJECTED'
                ? 'Rejected: your uncommitted work in this repository was left untouched.'
                : 'Approval timed out; your uncommitted work was left untouched.',
              'CANCELLED',
            );
          }
        }
      }

      if (isRepo && config.git.checkpoint) {
        const checkpoint = await git.createCheckpoint(task.id);
        if (checkpoint) {
          checkpointRef = checkpoint.ref;
          tasks.addEvent(task.id, 'git', `Checkpoint ${checkpoint.commit.slice(0, 8)} at ${checkpoint.ref}`);
          reporter.update(`🔒 Checkpoint created (${checkpoint.commit.slice(0, 8)}) — your work is recoverable.`);
        }
      }

      if (controller.signal.aborted) return await fail('Cancelled before execution.', 'CANCELLED');

      // ---- Verification commands ---------------------------------------------------
      const commands = detectCommands(project.path, {
        testCommand: project.testCommand,
        buildCommand: project.buildCommand,
      });
      const testCommand = commands.find((c) => c.kind === 'test') ?? null;
      const buildCommand = commands.find((c) => c.kind === 'build') ?? null;

      // ---- Copilot execution with bounded recovery ---------------------------------
      const policy = buildPermissionPolicy({
        allowedUrls: config.safety.allowedUrls,
        extraDeniedCommands: config.safety.extraDeniedCommands,
        extraDirs: project.extraDirs ?? [],
      });

      const deadline = startedAt + config.limits.maxTaskDurationMs;
      let attempt = 0;
      let lastFailureContext: string | null = null;
      let copilotResult: CopilotRunResult | null = null;
      let verificationsPassed = false;

      while (attempt <= config.limits.maxRetries) {
        if (controller.signal.aborted) return await fail('Cancelled by operator.', 'CANCELLED');

        const remainingMs = deadline - Date.now();
        // The guard band only applies to retries: a first attempt always gets to
        // start, even with a short budget, so the timeout is reported honestly.
        if (remainingMs <= 0 || (attempt > 0 && remainingMs <= 30_000)) {
          return await fail(
            `Task exceeded MAX_TASK_DURATION_MINUTES (${config.limits.maxTaskDurationMs / 60_000} min).`,
            'TIMED_OUT',
          );
        }

        // Per-task credit guard, evaluated between invocations.
        if (config.limits.maxAiCreditsPerTask > 0 && usage.aiCredits >= config.limits.maxAiCreditsPerTask) {
          await reporter.milestone(
            `🛑 Stopping: task AI-credit budget reached (${usage.aiCredits.toFixed(2)} / ${config.limits.maxAiCreditsPerTask}).`,
          );
          break;
        }

        tasks.transition(task.id, 'RUNNING');
        reporter.update(attempt === 0 ? '🔍 Copilot is inspecting the repository…' : `🔁 Recovery attempt ${attempt}…`);

        const prompt = buildTaskPrompt({
          userRequest: task.prompt,
          project,
          testCommand: testCommand?.display ?? null,
          buildCommand: buildCommand?.display ?? null,
          attempt,
          failureContext: lastFailureContext,
          autoCommit: false, // this app performs the commit itself
        });

        copilotResult = await runCopilot({
          launcher: copilot.launcher!,
          cwd: project.path,
          prompt,
          model: selection.model,
          effort: config.copilot.effort,
          agent: config.copilot.agent,
          autopilot: config.copilot.autopilot,
          maxAutopilotContinues: config.copilot.maxAutopilotContinues,
          permissionArgs: policy.args,
          timeoutMs: Math.min(remainingMs, config.limits.maxTaskDurationMs),
          maxTurns: Math.max(20, config.copilot.maxAutopilotContinues * 10),
          creditBudget: config.limits.maxAiCreditsPerTask,
          secretEnvVars: ['TELEGRAM_BOT_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN'],
          signal: controller.signal,
          onProgress: (update) => {
            if (update.kind === 'tool') reporter.update(`🛠 ${update.text}`);
            else if (update.kind === 'thinking') reporter.update(`💭 ${update.text.split('\n')[0]?.slice(0, 160)}`);
            else if (update.kind === 'message') reporter.update(`🤖 ${update.text.split('\n')[0]?.slice(0, 200)}`);
            else if (update.kind === 'limit' || update.kind === 'warning') reporter.update(`⚠️ ${update.text}`);
          },
        });

        usage.aiCredits += copilotResult.aiCredits;
        usage.outputTokens += copilotResult.outputTokens;
        if (copilotResult.sessionId) usage.copilotSessionIds.push(copilotResult.sessionId);
        tasks.updateUsage(task.id, usage, selection.model);
        tasks.addEvent(task.id, 'copilot', `attempt=${attempt} stop=${copilotResult.stopReason} credits=${copilotResult.aiCredits}`);

        if (copilotResult.stopReason === 'cancelled') return await fail('Cancelled by operator.', 'CANCELLED');
        if (copilotResult.stopReason === 'timeout') {
          return await fail('Copilot exceeded the task time limit and was stopped.', 'TIMED_OUT');
        }
        if (copilotResult.stopReason === 'quota-exhausted') {
          return await fail(
            '🛑 Copilot reported that your included usage is exhausted or rate limited.\n\n' +
              'The task was stopped. No additional paid usage was enabled.\n' +
              (copilotResult.stderr ? `\nDetail: ${tailLines(copilotResult.stderr, 4)}` : ''),
          );
        }
        if (copilotResult.stopReason === 'credit-limit') {
          await reporter.milestone(`🛑 AI-credit budget for this task reached; stopping.`);
          break;
        }
        if (copilotResult.stopReason === 'spawn-error') {
          return await fail(`Could not start Copilot CLI: ${tailLines(copilotResult.stderr, 5)}`);
        }
        if (copilotResult.exitCode !== 0) {
          lastFailureContext = `Copilot exited with code ${copilotResult.exitCode}. ${tailLines(copilotResult.stderr, 10)}`;
          attempt += 1;
          continue;
        }

        // ---- Verification ----------------------------------------------------------
        tasks.transition(task.id, 'TESTING');
        const attemptVerifications: VerificationResult[] = [];

        if (config.verify.runTests && testCommand) {
          await reporter.milestone(`🧪 Running tests: ${testCommand.display}`);
          const result = await this.runVerification(testCommand, project, config, controller.signal);
          attemptVerifications.push(result);
        }
        if (config.verify.runBuild && buildCommand) {
          const testsFailed = attemptVerifications.some((v) => !v.passed);
          if (!testsFailed) {
            await reporter.milestone(`🏗 Running build: ${buildCommand.display}`);
            const result = await this.runVerification(buildCommand, project, config, controller.signal);
            attemptVerifications.push(result);
          }
        }

        verifications.length = 0;
        verifications.push(...attemptVerifications);

        const failed = attemptVerifications.filter((v) => !v.passed);
        if (failed.length === 0) {
          verificationsPassed = true;
          if (attemptVerifications.length > 0) await reporter.milestone('✅ Verification passed');
          break;
        }

        const failure = failed[0]!;
        await reporter.milestone(`❌ ${failure.kind} failed (${failure.command}) — attempting recovery`);
        lastFailureContext = `The \`${failure.kind}\` step failed.\nCommand: ${failure.command}\nExit code: ${failure.exitCode}\nOutput (tail):\n${failure.summary}`;
        attempt += 1;
      }

      if (attempt > config.limits.maxRetries && !verificationsPassed) {
        tasks.transition(task.id, 'RUNNING');
      }

      // ---- Results -----------------------------------------------------------------
      const changedFiles = isRepo
        ? await git.diffNameOnly(baseCommit)
        : (copilotResult?.filesModified ?? []).map((f) => path.relative(project.path, f));
      const safeChangedFiles = changedFiles.filter((f) => !isSensitiveFile(f));

      let commitHash: string | null = null;
      const shouldCommit =
        verificationsPassed && config.git.autoCommit && isRepo && safeChangedFiles.length > 0 && !controller.signal.aborted;

      if (shouldCommit) {
        const isProtected = branch !== null && config.git.protectedBranches.includes(branch);
        let mayCommit = true;

        if (isProtected && config.safety.requireApprovalForDangerousActions) {
          reporter.update(`⚠️ Branch "${branch}" is protected — asking for approval to commit…`);
          const outcome = await approvals.request({
            taskId: task.id,
            chatId: task.chatId,
            title: 'Commit to a protected branch',
            project: project.name,
            reason: `Branch "${branch}" is listed in PROTECTED_BRANCHES.`,
            details: safeChangedFiles.slice(0, 15),
          });
          mayCommit = outcome === 'APPROVED';
          if (!mayCommit) tasks.addEvent(task.id, 'git', 'Commit to protected branch declined');
        }

        if (mayCommit) {
          await reporter.milestone('📦 Creating commit…');
          const staged = await git.stageAll((file) => isSensitiveFile(file));
          if (staged.length > 0 && (await git.hasStagedChanges())) {
            const message = this.commitMessage(task, project);
            const commit = await git.commit(message);
            if (commit.ok) {
              commitHash = commit.hash;
              tasks.addEvent(task.id, 'git', `Committed ${commitHash?.slice(0, 8)}`);
            } else {
              tasks.addEvent(task.id, 'git', `Commit failed: ${tailLines(commit.output, 3)}`);
            }
          }
        }
      }

      if (commitHash && config.git.autoPush && branch) {
        const outcome = await approvals.request({
          taskId: task.id,
          chatId: task.chatId,
          title: 'Push to remote',
          project: project.name,
          reason: `AUTO_PUSH is enabled. Push ${commitHash.slice(0, 8)} to origin/${branch}?`,
          details: safeChangedFiles.slice(0, 15),
        });
        if (outcome === 'APPROVED') {
          const pushed = await git.push(branch);
          tasks.addEvent(task.id, 'git', pushed.ok ? 'Pushed to origin' : `Push failed: ${tailLines(pushed.output, 3)}`);
          await reporter.milestone(pushed.ok ? '⬆️ Pushed to origin' : '⚠️ Push failed');
        }
      }

      const diffStat = isRepo ? await git.diffStat(baseCommit) : '';
      const linesMatch = /(\d+) insertions?\(\+\)/.exec(diffStat);
      const removedMatch = /(\d+) deletions?\(-\)/.exec(diffStat);

      const detail: TaskResultDetail = {
        filesChanged: safeChangedFiles,
        linesAdded: copilotResult?.linesAdded || (linesMatch ? Number(linesMatch[1]) : 0),
        linesRemoved: copilotResult?.linesRemoved || (removedMatch ? Number(removedMatch[1]) : 0),
        verifications,
        summary: (copilotResult?.finalMessage ?? '').slice(0, 2000),
        checkpointRef,
      };

      const succeeded =
        copilotResult !== null &&
        copilotResult.exitCode === 0 &&
        (verifications.length === 0 || verificationsPassed);

      const finalStatus = succeeded ? 'COMPLETED' : 'FAILED';
      tasks.transition(task.id, finalStatus, {
        result: detail,
        commitHash,
        branch,
        usage,
        error: succeeded ? null : this.failureSummary(verifications, copilotResult),
      });

      await reporter.close();
      await notifier.sendMessage(
        task.chatId,
        formatReport({
          task: tasks.get(task.id)!,
          projectName: project.name,
          model: selection.model,
          durationMs: Date.now() - startedAt,
          checkpointRef,
        }),
      );

      return { status: finalStatus, message: detail.summary };
    } catch (err) {
      log.error('Task run crashed', { taskId: task.id, error: errorMessage(err) });
      return await fail(`Internal error: ${errorMessage(err)}`);
    } finally {
      this.cancellations.delete(task.id);
      await reporter.close();
    }
  }

  private failureSummary(verifications: VerificationResult[], copilotResult: CopilotRunResult | null): string {
    const failed = verifications.filter((v) => !v.passed);
    if (failed.length > 0) {
      return failed.map((v) => `${v.kind} failed: ${v.command}\n${v.summary}`).join('\n\n').slice(0, 4000);
    }
    if (copilotResult && copilotResult.exitCode !== 0) {
      return `Copilot exited with code ${copilotResult.exitCode}.\n${tailLines(copilotResult.stderr, 10)}`;
    }
    return 'Task did not complete successfully.';
  }

  private commitMessage(task: Task, project: ProjectRecord): string {
    const firstLine = task.prompt.split('\n')[0]!.trim();
    const subject = firstLine.length > 68 ? `${firstLine.slice(0, 65)}...` : firstLine;
    return [
      subject,
      '',
      `Automated change produced by remote-agent task #${task.id}.`,
      `Project: ${project.name}`,
      '',
      `Original request: ${redact(task.prompt).slice(0, 500)}`,
    ].join('\n');
  }

  private async runVerification(
    command: DetectedCommand,
    project: ProjectRecord,
    config: AppConfig,
    signal: AbortSignal,
  ): Promise<VerificationResult> {
    // shell:true is required for package-manager shims on Windows (npm.cmd etc.).
    // The command originates from manifest detection or the project registry —
    // never from Telegram input.
    const result = await execCommand(command.command, command.args, {
      cwd: project.path,
      timeoutMs: config.limits.verifyTimeoutMs,
      shell: process.platform === 'win32',
      signal,
    });

    const combined = `${result.stdout}\n${result.stderr}`;
    return {
      kind: command.kind,
      command: command.display,
      exitCode: result.code,
      passed: result.code === 0 && !result.timedOut,
      durationMs: result.durationMs,
      summary: tailLines(combined, result.code === 0 ? 6 : 25).slice(0, 3000),
    };
  }
}
