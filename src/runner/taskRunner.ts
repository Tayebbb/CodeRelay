import path from 'node:path';
import fs from 'node:fs';
import type { AppConfig } from '../core/config.js';
import { createLogger, errorMessage } from '../core/logger.js';
import { isSensitiveFile, redact } from '../core/redact.js';
import type { TaskRepository } from '../db/taskRepository.js';
import type { Task, TaskResultDetail, TaskUsage, VerificationResult } from '../domain/task.js';
import { EMPTY_USAGE, isTerminal } from '../domain/task.js';
import type { ProjectRecord, ProjectRegistry } from '../projects/registry.js';
import type { DetectedCommand } from '../verify/detector.js';
import { describeManifestDiff, diffManifests, fingerprintManifests } from '../verify/integrity.js';
import { execCommand, tailLines } from '../util/exec.js';
import { insufficientDiskSpace } from '../util/disk.js';
import { buildPermissionPolicy } from '../copilot/permissions.js';
import { buildChildEnv } from '../copilot/childEnv.js';
import { runCopilot, type CopilotRunResult } from '../copilot/executor.js';
import type { CopilotInfo, CopilotLauncher } from '../copilot/detect.js';
import { selectModel } from '../copilot/detect.js';
import { ProgressReporter, type Notifier } from '../notify/notifier.js';
import type { ApprovalService } from '../approval/service.js';
import { buildExplorerPrompt, buildReviewPrompt, buildTaskPrompt } from './promptBuilder.js';
import { prepareRepository } from './preflight.js';
import { publishChanges } from './publish.js';
import { decideAfterCopilot, UNREPORTED_USAGE_FAILURE } from './stopReason.js';
import { classifyTask, escalate, shouldReview } from '../orchestrator/plan.js';
import { assessConfidence, parseReview, type ConfidenceResult } from '../orchestrator/confidence.js';
import { formatReport } from '../telegram/format.js';

const log = createLogger('runner');

/** Names the CLI must mask if a child ever echoes them. */
const SECRET_ENV_VARS = ['TELEGRAM_BOT_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN'];

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
    // Seeded from what this task has ALREADY spent, not from zero. A recovered
    // task keeps its usage in the database; starting the in-memory counter at
    // zero made updateUsage() compute a negative delta, which wrote no ledger
    // row at all — so the re-spend was invisible to the daily budget and the
    // per-task cap restarted on every recovery.
    const usage: TaskUsage = {
      ...EMPTY_USAGE,
      ...task.usage,
      copilotSessionIds: [...(task.usage?.copilotSessionIds ?? [])],
    };
    const verifications: VerificationResult[] = [];
    let checkpointRef: string | undefined;

    const fail = async (message: string, status: RunOutcome['status'] = 'FAILED'): Promise<RunOutcome> => {
      // Last-resort path: it must never throw, or the task is stranded in a
      // non-terminal state and gets re-queued (and re-billed) on every restart.
      try {
        const current = tasks.get(task.id);
        if (current && !isTerminal(current.status)) {
          tasks.transition(task.id, status, { error: message, usage });
        }
      } catch (err) {
        log.error('Could not record terminal state', { taskId: task.id, error: errorMessage(err) });
      }
      try {
        await reporter.close();
      } catch {
        // ignore
      }
      try {
        await notifier.sendMessage(
          task.chatId,
          `${status === 'CANCELLED' ? '🚫' : '❌'} Task #${task.id}\n\n${message}`,
        );
      } catch {
        // ignore
      }
      return { status, message };
    };

    try {
      const project = projects.getById(task.projectId);
      if (!project) return await fail(`Project "${task.projectId}" is no longer registered.`);
      if (!fs.existsSync(project.path)) {
        return await fail(`Project path no longer exists: ${project.path}`);
      }

      // A full disk breaks the checkpoint, the database and the agent's edits at
      // the same time. Refuse cleanly instead of failing halfway through.
      const diskProblem = insufficientDiskSpace(project.path);
      if (diskProblem) {
        return await fail(`Not enough disk space to work safely: ${diskProblem}. Nothing was started.`);
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
      // Checked here rather than asserted at each call site: without a launcher
      // there is no way to start Copilot at all.
      const launcher = copilot.launcher;
      if (!launcher) {
        return await fail(
          'Copilot CLI is not usable on this machine (no safe way to launch it was found).\n' +
            'Run `remote-agent doctor` for details.',
        );
      }

      const selection = selectModel(config.copilot.model, config.copilot.modelFallback, copilot.models);
      // The catalogue is not an entitlement: a listed model can still be refused
      // at run time once its allowance is spent, so this can change mid-task.
      let activeModel = selection.model;
      // Distinct from selection.fellBack: that one reacts to the CLI catalogue,
      // this one to the API refusing a catalogued model at run time.
      let runtimeModelSwitchUsed = false;
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

      // ---- Repository preparation --------------------------------------------------
      const prepared = await prepareRepository({
        task,
        project,
        config,
        tasks,
        approvals,
        reporter,
        signal: controller.signal,
      });
      if (!prepared.ok) return await fail(prepared.message, prepared.cancelled ? 'CANCELLED' : 'FAILED');

      const {
        git,
        isRepo,
        branch,
        baseCommit,
        checkpointCommit,
        testCommand,
        buildCommand,
        manifestsBefore,
        commandScripts,
        checkGitSurface: gitSurfaceViolation,
        checkRepoConfig: repoConfigViolation,
      } = prepared.repository;
      checkpointRef = prepared.repository.checkpointRef ?? undefined;

      // ---- Copilot execution with bounded recovery ---------------------------------
      const policy = buildPermissionPolicy({
        allowedUrls: config.safety.allowedUrls,
        extraDeniedCommands: config.safety.extraDeniedCommands,
        extraDirs: project.extraDirs ?? [],
      });

      const deadline = startedAt + config.limits.maxTaskDurationMs;
      // APPROVAL_TIMEOUT_MINUTES defaults to 60 while MAX_TASK_DURATION_MINUTES
      // defaults to 30, so an unanswered card could hold the only queue slot
      // well past the task's own limit. Approvals raised DURING a task expire
      // with the task.
      const approvalSignal = (): AbortSignal =>
        AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1_000, deadline - Date.now()))]);
      let manifestBaseline = manifestsBefore;
      let attempt = 0;
      let lastFailureContext: string | null = null;
      let copilotResult: CopilotRunResult | null = null;
      let verificationsPassed = false;

      // ---- Orchestration plan (decided without spending anything) -------------------
      let plan = classifyTask({
        request: task.prompt,
        unverifiable: !testCommand && !buildCommand,
        maxAgentCalls: config.orchestration.enabled ? config.orchestration.maxAgentCalls : 1,
      });
      if (!config.orchestration.enabled) {
        plan = { ...plan, roles: ['implementer'], useExplorer: false, alwaysReview: false, agentBudget: 1 };
      }
      let agentCalls = 0;
      let explorationBrief: string | null = null;
      let reviewFindings: string[] | null = null;
      let reviewsDone = 0;
      let lastReviewVerdict: string | null = null;
      let confidence: ConfidenceResult | null = null;

      tasks.addEvent(task.id, 'plan', `${plan.complexity}: ${plan.reason} → ${plan.roles.join(' → ')}`);
      await reporter.milestone(`🧭 ${plan.complexity.toUpperCase()} — ${plan.roles.join(' → ')} (${plan.reason})`);

      // ---- Explorer: one cheap read-only survey, handed to the implementer ----------
      if (plan.useExplorer && agentCalls < plan.agentBudget) {
        reporter.update('🔭 Surveying the codebase (read-only)…');
        const surveyRun = await this.runAdvisorySession({
          role: 'explorer',
          prompt: buildExplorerPrompt({ userRequest: task.prompt, project }),
          project,
          launcher,
          model: activeModel,
          policyArgs: policy.args,
          config,
          signal: controller.signal,
          deadline,
          creditBudget: config.limits.maxAiCreditsPerTask,
          changedFiles: async () => (isRepo ? await git.diffNameOnly(checkpointCommit ?? baseCommit) : []),
          onProgress: (t) => reporter.update(t),
        });
        const survey = surveyRun.result;
        agentCalls += 1;
        usage.aiCredits += survey.aiCredits;
        usage.outputTokens += survey.outputTokens;
        tasks.updateUsage(task.id, usage, activeModel);
        // A read-only pass that touched git's control surface is as serious as
        // one that edited a source file, and the diff check cannot see `.git/`.
        const surveyTamper = gitSurfaceViolation();
        if (surveyRun.violation || surveyTamper) {
          const detail = [surveyRun.violation, surveyTamper].filter(Boolean).join('\n');
          tasks.addEvent(task.id, 'security', `Read-only survey modified the repository: ${detail.replace(/\n/g, '; ')}`);
          return await fail(
            'Stopped: the read-only survey pass modified the working tree, which it must never do.\n\n' +
              detail +
              '\n\nNothing was tested or committed. Inspect the changes before continuing.\n' +
              `Restore with: git checkout ${checkpointRef ?? 'HEAD'} -- .`,
          );
        }
        if (survey.stopReason === 'completed' && survey.finalMessage.trim().length > 40) {
          explorationBrief = survey.finalMessage.trim();
          tasks.addEvent(task.id, 'explore', `survey captured (${explorationBrief.length} chars)`);
        } else {
          // A failed survey is not fatal: the implementer can still explore.
          tasks.addEvent(task.id, 'explore', `survey unusable (${survey.stopReason}); continuing without it`);
        }
      }

      while (attempt <= config.limits.maxRetries) {
        if (controller.signal.aborted) return await fail('Cancelled by operator.', 'CANCELLED');

        const remainingMs = deadline - Date.now();
        // The guard band only applies to retries: a first attempt always gets to
        // start, even with a short budget, so the timeout is reported honestly.
        if (remainingMs <= 0 || (attempt > 0 && remainingMs <= 30_000)) {
          return await fail(
            `Task exceeded the ${config.limits.maxTaskDurationMs / 60_000} minute time limit (MAX_TASK_DURATION_MINUTES).`,
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

        // The DAILY cap is re-checked here too, not just at task start: a long
        // task with an explorer, retries and a review can cross it mid-flight,
        // and other tasks may have spent in the meantime.
        if (config.limits.maxAiCreditsPerDay > 0) {
          const spentToday = tasks.creditsUsedSince(24 * 60 * 60 * 1000);
          if (spentToday >= config.limits.maxAiCreditsPerDay) {
            await reporter.milestone(
              `🛑 Stopping: daily AI-credit budget reached (${spentToday.toFixed(2)} / ${config.limits.maxAiCreditsPerDay}).`,
            );
            break;
          }
        }

        // Hard ceiling on paid sessions, counted across every role.
        if (agentCalls >= plan.agentBudget) {
          tasks.addEvent(task.id, 'plan', `agent budget of ${plan.agentBudget} reached`);
          await reporter.milestone(`🛑 Stopping: agent budget of ${plan.agentBudget} session(s) reached.`);
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
          explorationBrief,
          reviewFindings,
        });

        copilotResult = await runCopilot({
          launcher,
          cwd: project.path,
          prompt,
          model: activeModel,
          effort: config.copilot.effort,
          agent: config.copilot.agent,
          autopilot: config.copilot.autopilot,
          maxAutopilotContinues: config.copilot.maxAutopilotContinues,
          permissionArgs: policy.args,
          timeoutMs: Math.min(remainingMs, config.limits.maxTaskDurationMs),
          maxTurns: Math.max(20, config.copilot.maxAutopilotContinues * 10),
          creditBudget: config.limits.maxAiCreditsPerTask,
          sandbox: config.copilot.sandbox,
          secretEnvVars: SECRET_ENV_VARS,
          envPassthrough: config.safety.envPassthrough,
          allowRepoInstructions: config.safety.allowRepoInstructions,
          githubMcp: config.safety.githubMcp,
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
        agentCalls += 1;
        // Findings are consumed by exactly one fix pass, never re-sent.
        reviewFindings = null;
        tasks.updateUsage(task.id, usage, activeModel);
        tasks.addEvent(
          task.id,
          'copilot',
          `attempt=${attempt} stop=${copilotResult.stopReason} credits=${copilotResult.aiCredits}`,
        );

        const tamper = gitSurfaceViolation();
        const injectedConfig = repoConfigViolation();
        if (injectedConfig) {
          tasks.addEvent(task.id, 'security', `Copilot config appeared during the run: ${injectedConfig.replace(/\n/g, '; ')}`);
          return await fail(
            'Stopped: Copilot configuration appeared in the repository while the task was running.\n\n' +
              injectedConfig +
              '\n\nThe CLI loads that on the next session, so it can replace the safety rules this\n' +
              'system relies on. Nothing was committed.\n' +
              `Inspect it, then restore with: git checkout ${checkpointRef ?? 'HEAD'} -- .`,
          );
        }
        const action = decideAfterCopilot({
          result: copilotResult,
          activeModel,
          availableModels: copilot.models,
          configuredFallback: config.copilot.modelFallback,
          modelSwitchUsed: runtimeModelSwitchUsed,
          unreportedRuns: usage.unreportedRuns,
          tamper,
          checkpointRef,
        });

        if (action.kind === 'fail') {
          if (tamper) {
            tasks.addEvent(task.id, 'security', `Git control surface modified: ${tamper.replace(/\n/g, ', ')}`);
          }
          return await fail(action.message, action.status);
        }
        if (action.kind === 'halt') {
          await reporter.milestone(action.message);
          break;
        }
        if (action.kind === 'switch-model') {
          runtimeModelSwitchUsed = true;
          activeModel = action.model;
          tasks.addEvent(task.id, 'model', `"${action.previous}" was refused at run time; retrying with "${action.model}"`);
          await reporter.milestone(
            `⚠️ ${action.previous} is not available right now (its allowance is probably spent).\n` +
              `Retrying with ${action.model}.`,
          );
          continue; // deliberately not counted as a recovery attempt
        }
        if (action.kind === 'unreported-usage') {
          usage.unreportedRuns += 1;
          tasks.updateUsage(task.id, usage, activeModel);
          tasks.addEvent(task.id, 'usage', 'Copilot reported no usage figure for this run');
          if (action.fatal) return await fail(UNREPORTED_USAGE_FAILURE);
        }
        if (action.kind === 'retry') {
          lastFailureContext = action.failureContext;
          attempt += 1;
          continue;
        }

        // ---- Verification ----------------------------------------------------------
        if (controller.signal.aborted) return await fail('Cancelled by operator.', 'CANCELLED');
        tasks.transition(task.id, 'TESTING');
        const attemptVerifications: VerificationResult[] = [];

        const manifestDiff = diffManifests(manifestBaseline, fingerprintManifests(project.path, commandScripts));

        if (manifestDiff.any) {
          tasks.addEvent(task.id, 'security', `Build manifests changed: ${describeManifestDiff(manifestDiff).join(', ')}`);
          const outcome = await approvals.request(
            {
              taskId: task.id,
              chatId: task.chatId,
              title: 'Build/test definition changed',
              project: project.name,
              reason:
                'The agent modified files that control what the test/build step executes. ' +
                'Approve only if that was expected — these commands run with your full user rights.',
              details: describeManifestDiff(manifestDiff),
            },
            { signal: approvalSignal() },
          );
          if (outcome !== 'APPROVED') {
            return await fail(
              'Stopped: the agent changed the build/test definition and the change was not approved. ' +
                'No test or build command was executed.\n\n' +
                describeManifestDiff(manifestDiff).join('\n'),
              outcome === 'REJECTED' ? 'CANCELLED' : 'FAILED',
            );
          }
          // Re-baseline rather than disarm: the approved change is accepted, but
          // a FURTHER change on a later retry must be approved again.
          manifestBaseline = fingerprintManifests(project.path, commandScripts);
        }

        if (config.verify.runTests && testCommand) {
          await reporter.milestone(`🧪 Running tests: ${testCommand.display}`);
          const result = await this.runVerification(testCommand, project, config, controller.signal, deadline);
          attemptVerifications.push(result);
        }
        if (config.verify.runBuild && buildCommand) {
          const testsFailed = attemptVerifications.some((v) => !v.passed);
          if (!testsFailed) {
            await reporter.milestone(`🏗 Running build: ${buildCommand.display}`);
            const result = await this.runVerification(buildCommand, project, config, controller.signal, deadline);
            attemptVerifications.push(result);
          }
        }

        verifications.length = 0;
        verifications.push(...attemptVerifications);

        const failed = attemptVerifications.filter((v) => !v.passed);
        if (failed.length === 0) {
          verificationsPassed = true;
          if (attemptVerifications.length > 0) await reporter.milestone('✅ Verification passed');

          // ---- Self-evaluation: is a paid second opinion worth it? -----------------
          const reviewBase = checkpointCommit ?? baseCommit;
          const changedNow = isRepo ? await git.diffNameOnly(reviewBase) : [];
          const safeChangedNow = changedNow.filter((f) => !isSensitiveFile(f));
          plan = escalate(plan, safeChangedNow);

          confidence = assessConfidence({
            testsRun: attemptVerifications.some((v) => v.kind === 'test'),
            testsPassed: attemptVerifications.filter((v) => v.kind === 'test').every((v) => v.passed),
            buildRun: attemptVerifications.some((v) => v.kind === 'build'),
            buildPassed: attemptVerifications.filter((v) => v.kind === 'build').every((v) => v.passed),
            retriesUsed: attempt,
            changedFiles: safeChangedNow,
            linesChanged: isRepo ? await git.diffLineCount(reviewBase) : 0,
            stopReason: copilotResult.stopReason,
            manifestsChanged: manifestDiff.any,
          });
          tasks.addEvent(
            task.id,
            'confidence',
            `${confidence.score.toFixed(2)} (${confidence.factors.join('; ')})`,
          );

          const decision = shouldReview(plan, {
            enabled: config.orchestration.enabled,
            changedFileCount: safeChangedNow.length,
            reviewsDone,
            confidence: confidence.score,
            threshold: config.orchestration.reviewThreshold,
            agentCallsUsed: agentCalls,
            attempt,
            maxRetries: config.limits.maxRetries,
            creditsUsed: usage.aiCredits,
            maxCreditsPerTask: config.limits.maxAiCreditsPerTask,
          });

          if (!decision.review) {
            if (decision.reason === 'unaffordable') {
              // Report honestly rather than pretending the change was reviewed.
              tasks.addEvent(task.id, 'review', 'review skipped: agent budget or retry budget exhausted');
              await reporter.milestone(
                `⚠️ Confidence ${(confidence.score * 100).toFixed(0)}% — a review was wanted but the budget is spent`,
              );
            } else {
              await reporter.milestone(`🧠 Confidence ${(confidence.score * 100).toFixed(0)}% — no review needed`);
            }
            break;
          }

          const securityFocus = plan.roles.includes('security-reviewer') || plan.securitySubject;
          reporter.update(securityFocus ? '🔐 Security review (read-only)…' : '👓 Code review (read-only)…');
          const reviewRun = await this.runAdvisorySession({
            role: 'reviewer',
            prompt: buildReviewPrompt({
              userRequest: task.prompt,
              project,
              diff: isRepo ? await git.diffUnified(reviewBase, safeChangedNow) : '',
              changedFiles: safeChangedNow,
              securityFocus,
              verificationSummary: attemptVerifications
                .map((v) => `${v.kind}: ${v.command} → ${v.passed ? 'passed' : 'FAILED'}`)
                .join('\n'),
            }),
            project,
            launcher,
            model: activeModel,
            policyArgs: policy.args,
            config,
            signal: controller.signal,
            deadline,
            creditBudget: config.limits.maxAiCreditsPerTask,
            changedFiles: async () => (isRepo ? await git.diffNameOnly(reviewBase) : []),
            onProgress: (t) => reporter.update(t),
          });
          agentCalls += 1;
          reviewsDone += 1;
          const reviewSession = reviewRun.result;
          usage.aiCredits += reviewSession.aiCredits;
          usage.outputTokens += reviewSession.outputTokens;
          tasks.updateUsage(task.id, usage, activeModel);

          if (reviewRun.violation || gitSurfaceViolation()) {
            const detail = [reviewRun.violation, gitSurfaceViolation()].filter(Boolean).join('\n');
            tasks.addEvent(task.id, 'security', `Read-only review modified the repository: ${detail.replace(/\n/g, '; ')}`);
            return await fail(
              'Stopped: the read-only review pass modified the working tree, which it must never do.\n\n' +
                detail +
                '\n\nNothing was committed. Inspect the changes before continuing.\n' +
                `Restore with: git checkout ${checkpointRef ?? 'HEAD'} -- .`,
            );
          }

          const review = parseReview(reviewSession.finalMessage);
          lastReviewVerdict = review.verdict;
          tasks.addEvent(task.id, 'review', `${review.verdict} (${review.findings.length} finding(s))`);

          if (review.verdict === 'changes-required' && review.findings.length > 0) {
            await reporter.milestone(
              `🔁 Review found ${review.findings.length} issue(s) — fixing:\n` +
                review.findings.slice(0, 5).map((f) => `• ${f}`).join('\n'),
            );
            reviewFindings = review.findings;
            lastFailureContext = null;
            verificationsPassed = false;
            attempt += 1;
            continue; // PLAN → IMPLEMENT → TEST → REVIEW → FIX → TEST AGAIN
          }

          await reporter.milestone(
            review.verdict === 'pass'
              ? '✅ Review passed'
              : '⚠️ Review returned no clear verdict — treating as advisory only',
          );
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
      // The checkpoint captures the pre-task tree including the user's own
      // uncommitted edits, so diffing against it yields exactly what the agent
      // changed — and nothing the user had already written.
      const compareBase = checkpointCommit ?? baseCommit;
      const changedFiles = isRepo
        ? await git.diffNameOnly(compareBase)
        : (copilotResult?.filesModified ?? []).map((f) => path.relative(project.path, f));
      const safeChangedFiles = changedFiles.filter((f) => !isSensitiveFile(f));

      // Final guard before anything is staged, committed or pushed: the loop may
      // have exited through a break (credit limit) rather than the checks above.
      const finalTamper = gitSurfaceViolation();
      if (finalTamper) {
        tasks.addEvent(task.id, 'security', `Git control surface modified: ${finalTamper.replace(/\n/g, ', ')}`);
        return await fail(
          'Stopped: the agent modified git hooks or git configuration.\n\n' +
            finalTamper +
            '\n\nThose files execute commands as you. Nothing was committed or pushed.',
        );
      }

      // Committing unverified work is only allowed when explicitly configured: a
      // project with no detectable test/build command would otherwise get
      // auto-commits that nothing ever checked. `verificationsPassed` is checked
      // separately because it stays false when the loop broke out early (credit
      // or agent budget), which must never be mistaken for success.
      const verificationSatisfied =
        verifications.length > 0 ? verificationsPassed : config.git.allowCommitWithoutVerification;
      const shouldCommit =
        verificationSatisfied &&
        verificationsPassed &&
        config.git.autoCommit &&
        isRepo &&
        safeChangedFiles.length > 0 &&
        !controller.signal.aborted;

      let commitHash: string | null = null;
      if (shouldCommit) {
        const published = await publishChanges({
          task,
          project,
          config,
          tasks,
          approvals,
          reporter,
          signal: approvalSignal(),
          git,
          branch,
          changedFiles: safeChangedFiles,
          commitMessage: this.commitMessage(task, project),
        });
        commitHash = published.commitHash;
      }

      const diffStat = isRepo ? await git.diffStat(compareBase) : '';
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
          model: activeModel,
          durationMs: Date.now() - startedAt,
          checkpointRef,
          plan: `${plan.complexity} · ${plan.roles.join(' → ')} · ${agentCalls} session(s)`,
          confidence: confidence?.score,
          reviewVerdict: lastReviewVerdict ?? undefined,
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
    deadline: number,
  ): Promise<VerificationResult> {
    // The verification command is PROJECT-SUPPLIED code (npm test, make test).
    // It must not inherit the operator's environment — that would hand a hostile
    // repository the Telegram bot token and every credential in the shell.
    const timeoutMs = Math.max(5_000, Math.min(config.limits.verifyTimeoutMs, deadline - Date.now()));
    const result = await execCommand(command.command, command.args, {
      cwd: project.path,
      timeoutMs,
      shell: process.platform === 'win32',
      signal,
      env: buildChildEnv(process.env, { passthrough: config.safety.envPassthrough }),
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

  /**
   * Run a READ-ONLY Copilot session (explorer or reviewer).
   *
   * `--deny-tool=write` with no path denies every write tool, so these roles
   * physically cannot modify the tree — the safety of the advisory passes does
   * not depend on the prompt being obeyed.
   */
  private async runAdvisorySession(options: {
    role: 'explorer' | 'reviewer';
    prompt: string;
    project: ProjectRecord;
    launcher: CopilotLauncher;
    model: string;
    policyArgs: string[];
    config: AppConfig;
    signal: AbortSignal;
    deadline: number;
    creditBudget: number;
    /** Lists the files currently changed; used to prove the pass wrote nothing. */
    changedFiles: () => Promise<string[]>;
    onProgress: (text: string) => void;
  }): Promise<{ result: CopilotRunResult; violation: string | null }> {
    const { config } = options;
    const remaining = options.deadline - Date.now();

    // `--deny-tool=write` does not cover shell writes (per the CLI's own docs),
    // and a live run was seen writing a file via PowerShell after its edit tool
    // was denied. So the read-only promise is verified here, not delegated.
    // Uses git, so the CLI's own ignored session artifacts do not count.
    const before = new Set(await options.changedFiles());

    const result = await runCopilot({
      launcher: options.launcher,
      cwd: options.project.path,
      prompt: options.prompt,
      model: options.model,
      effort: config.copilot.effort,
      agent: config.copilot.agent,
      // Advisory passes are single-shot: no autopilot continuations, few turns.
      autopilot: false,
      maxAutopilotContinues: 1,
      permissionArgs: [...options.policyArgs, '--deny-tool=write'],
      timeoutMs: Math.max(30_000, Math.min(remaining, config.limits.maxTaskDurationMs)),
      maxTurns: 12,
      creditBudget: options.creditBudget,
      sandbox: config.copilot.sandbox,
      secretEnvVars: SECRET_ENV_VARS,
      envPassthrough: config.safety.envPassthrough,
      allowRepoInstructions: config.safety.allowRepoInstructions,
      githubMcp: config.safety.githubMcp,
      signal: options.signal,
      onProgress: (update) => {
        if (update.kind === 'tool') options.onProgress(`🛠 ${update.text}`);
      },
    });

    const touched = (await options.changedFiles()).filter((f) => !before.has(f));
    return {
      result,
      violation: touched.length > 0 ? touched.slice(0, 10).join(', ') : null,
    };
  }
}
