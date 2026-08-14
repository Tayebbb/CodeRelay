/**
 * Everything that must be true before an autonomous agent is allowed to touch a
 * repository, in one place.
 *
 * This phase is deliberately separate from the agent loop: it is the part that
 * decides whether we run at all, and it is where the irreversible-damage risks
 * live (no way back, a conflicted tree, repository-supplied agent config). It
 * returns a discriminated result rather than throwing, so every refusal carries
 * the message the operator will actually read.
 */

import type { AppConfig } from '../core/config.js';
import { registerProjectSecrets } from '../core/redact.js';
import type { TaskRepository } from '../db/taskRepository.js';
import type { Task } from '../domain/task.js';
import type { ProjectRecord } from '../projects/registry.js';
import { Git, detectExecutableGitConfig } from '../git/git.js';
import { detectCommands, type DetectedCommand } from '../verify/detector.js';
import {
  describeManifestDiff,
  diffManifests,
  fingerprintGitControlSurface,
  fingerprintManifests,
  packageScriptTargets,
  referencedScripts,
  type ManifestFingerprint,
} from '../verify/integrity.js';
import { describeRepoFindings, scanRepositoryConfig } from '../security/repoScan.js';
import type { ApprovalService } from '../approval/service.js';
import type { ProgressReporter } from '../notify/notifier.js';

/** Recovery hint shown when a task is resumed after an interruption. */
export function checkpointRefHint(taskId: number): string {
  return `Snapshot from before the first attempt: git checkout refs/remote-agent/checkpoint-${taskId} -- .`;
}

export interface PreparedRepository {
  git: Git;
  isRepo: boolean;
  branch: string | null;
  /** HEAD before the agent ran, or null in a repository with no commits. */
  baseCommit: string | null;
  checkpointRef: string | null;
  checkpointCommit: string | null;
  testCommand: DetectedCommand | null;
  buildCommand: DetectedCommand | null;
  /** Files whose contents decide what the verification step executes. */
  manifestsBefore: ManifestFingerprint;
  commandScripts: string[];
  /** Non-null when git hooks or config changed since the baseline. */
  checkGitSurface: () => string | null;
  /**
   * Non-null when repository-supplied Copilot configuration appeared or changed
   * since it was approved. The CLI reloads agents, hooks and MCP servers on
   * EVERY session, so one scan per task is not enough: an injected implementer
   * can write `.mcp.json` on attempt 1 and have it loaded on attempt 2.
   */
  checkRepoConfig: () => string | null;
}

export type PreparationOutcome =
  | { ok: true; repository: PreparedRepository }
  | { ok: false; message: string; cancelled: boolean };

export interface PrepareInput {
  task: Task;
  project: ProjectRecord;
  config: AppConfig;
  tasks: TaskRepository;
  approvals: ApprovalService;
  reporter: ProgressReporter;
  signal: AbortSignal;
}

const refuse = (message: string, cancelled = false): PreparationOutcome => ({ ok: false, message, cancelled });

/**
 * Inspect the repository, take a recovery checkpoint, and gate anything that
 * would let the repository control the agent. Every early return is a refusal
 * to start, never a partial start.
 */
export async function prepareRepository(input: PrepareInput): Promise<PreparationOutcome> {
  const { task, project, config, tasks, approvals, reporter, signal } = input;

  const git = new Git(project.path);
  const isRepo = await git.isRepository();

  // BEFORE any git command that reads the worktree. A filter driver defined in
  // .git/config executes a command during `git add`/`git status`, which would
  // otherwise run at checkpoint time — before the repository scan, before any
  // approval, and with our environment. `-c` hardening cannot disable these.
  const executableConfig = isRepo ? detectExecutableGitConfig(project.path, null) : [];
  if (executableConfig.length > 0) {
    tasks.addEvent(task.id, 'security', `Executable git config: ${executableConfig.join('; ')}`);
    return refuse(
      'This repository configures git to run commands when it merely reads files:\n\n' +
        executableConfig.map((f) => `  - ${f}`).join('\n') +
        '\n\nThat code would execute as you, before anything could be checked, so the task was\n' +
        'not started and nothing was modified. Remove the filter/diff driver, or run this\n' +
        'repository yourself if you put it there deliberately.',
    );
  }

  // Baseline BEFORE any other git command: checkpointing itself runs
  // `git add -A`, which would execute a hostile filter driver.
  const resolvedGitDir = isRepo ? await git.gitDir() : null;
  const gitSurfaceBaseline = isRepo ? fingerprintGitControlSurface(project.path, resolvedGitDir) : {};
  const checkGitSurface = (): string | null => {
    if (!isRepo) return null;
    const diff = diffManifests(gitSurfaceBaseline, fingerprintGitControlSurface(project.path, resolvedGitDir));
    return diff.any ? describeManifestDiff(diff).join('\n') : null;
  };

  if (isRepo) await git.sweepStaleIndexFiles();
  const status = isRepo ? await git.status() : null;

  // A conflicted tree must never be handed to an autonomous agent: staging it
  // would commit conflict markers, and "resolving" it could destroy work.
  if (status && status.unmerged.length > 0) {
    return refuse(
      `This repository has ${status.unmerged.length} unresolved merge conflict(s). ` +
        'Resolve them yourself first — the agent will not touch a conflicted tree.\n\n' +
        status.unmerged.slice(0, 10).join('\n'),
    );
  }

  // A broken git means no checkpoint and no dirty-work guard. Refuse rather
  // than run an autonomous agent with no way back.
  if (status?.error) {
    return refuse(
      `Git is not working in this project: ${status.error}\n\n` +
        'Refusing to run: without git there is no checkpoint and no way to undo the agent.',
    );
  }

  if (isRepo && status && !status.clean) {
    const outcome = await approveDirtyTree({ task, project, config, tasks, approvals, reporter, signal, status });
    if (outcome) return outcome;
  }

  let checkpointRef: string | null = null;
  let checkpointCommit: string | null = null;
  const baseCommit = status?.head ?? null;

  if (isRepo && config.git.checkpoint) {
    const checkpoint = await git.createCheckpoint(task.id);
    if (checkpoint) {
      checkpointRef = checkpoint.ref;
      checkpointCommit = checkpoint.commit;
      tasks.addEvent(task.id, 'git', `Checkpoint ${checkpoint.commit.slice(0, 8)} at ${checkpoint.ref}`);
      reporter.update(`🔒 Checkpoint created (${checkpoint.commit.slice(0, 8)}) — your work is recoverable.`);
    } else if (baseCommit !== null) {
      // A repository with commits that cannot be snapshotted means something is
      // wrong with git or the disk. Running on would remove the only route back.
      return refuse(
        'Could not create a recovery checkpoint for this repository, so the agent was not started.\n' +
          'This usually means git failed or the disk is full. Nothing was modified.',
      );
    } else {
      tasks.addEvent(task.id, 'git', 'Repository has no commits yet; no checkpoint is possible');
      reporter.update('⚠️ Repository has no commits yet — no checkpoint is possible.');
    }
  } else if (!isRepo) {
    tasks.addEvent(task.id, 'git', 'Project is not a git repository; no checkpoint or rollback available');
    await reporter.milestone(
      '⚠️ This project is not a git repository. There is no checkpoint and no way to undo the agent.',
    );
  }

  if (signal.aborted) return refuse('Cancelled before execution.', true);

  // Learn this project's own secret values so that if the agent ever echoes one
  // it is stripped from every message, log and stored record.
  const learnedSecrets = registerProjectSecrets(project.path);
  if (learnedSecrets > 0) {
    tasks.addEvent(task.id, 'security', `Registered ${learnedSecrets} project secret value(s) for redaction`);
  }

  const repoConfigRefusal = await approveRepositoryConfig({ task, project, config, tasks, approvals, signal });
  if (repoConfigRefusal) return repoConfigRefusal;

  // Baseline taken AFTER approval, so anything appearing later is new.
  const approvedConfig = describeRepoFindings(
    scanRepositoryConfig(project.path, {
      agentName: config.copilot.agent,
      allowRepoInstructions: config.safety.allowRepoInstructions,
    }).blocking,
  ).join('\n');
  const checkRepoConfig = (): string | null => {
    const now = describeRepoFindings(
      scanRepositoryConfig(project.path, {
        agentName: config.copilot.agent,
        allowRepoInstructions: config.safety.allowRepoInstructions,
      }).blocking,
    ).join('\n');
    return now === approvedConfig ? null : now;
  };

  const commands = detectCommands(project.path, {
    testCommand: project.testCommand,
    buildCommand: project.buildCommand,
  });
  const testCommand = commands.find((c) => c.kind === 'test') ?? null;
  const buildCommand = commands.find((c) => c.kind === 'build') ?? null;

  // Snapshot the files that define what verification will execute, so a
  // rewritten `scripts.test` cannot run unnoticed with full user privileges.
  const commandScripts = [
    ...referencedScripts(testCommand?.args ?? []),
    ...referencedScripts(buildCommand?.args ?? []),
    ...packageScriptTargets(project.path),
  ];

  return {
    ok: true,
    repository: {
      git,
      isRepo,
      branch: status?.branch ?? null,
      baseCommit,
      checkpointRef,
      checkpointCommit,
      testCommand,
      buildCommand,
      manifestsBefore: fingerprintManifests(project.path, commandScripts),
      commandScripts,
      checkGitSurface,
      checkRepoConfig,
    },
  };
}

type DirtyTreeInput = Omit<PrepareInput, 'signal'> & {
  signal: AbortSignal;
  status: NonNullable<Awaited<ReturnType<Git['status']>>>;
};

/** Returns a refusal when the operator declines to run on a dirty tree. */
async function approveDirtyTree(input: DirtyTreeInput): Promise<PreparationOutcome | null> {
  const { task, project, config, tasks, approvals, reporter, signal, status } = input;
  const dirtyCount = status.staged.length + status.modified.length + status.untracked.length;
  tasks.addEvent(task.id, 'git', `Repository has ${dirtyCount} uncommitted change(s)`);

  // A task that was interrupted (crash, power loss) restarts on a tree that may
  // already hold half of the previous attempt. Never resume that silently,
  // whatever the configured policy.
  const resumedAfterInterruption = task.retryCount > 0;
  if (!config.git.requireApprovalWhenDirty && !resumedAfterInterruption) return null;

  reporter.update('⚠️ Uncommitted changes detected — asking for approval…');
  const outcome = await approvals.request(
    {
      taskId: task.id,
      chatId: task.chatId,
      title: resumedAfterInterruption ? 'Resume a task that was interrupted' : 'Uncommitted changes present',
      project: project.name,
      reason: resumedAfterInterruption
        ? `This task was interrupted (attempt ${task.retryCount + 1}) and the working tree has ${dirtyCount} uncommitted change(s) — possibly a half-finished edit from the previous attempt. Re-running will work on top of them.`
        : `${dirtyCount} uncommitted file(s) in ${project.name}. The agent may modify them.`,
      details: [
        ...status.modified.slice(0, 8).map((f) => `M ${f}`),
        ...status.untracked.slice(0, 8).map((f) => `? ${f}`),
        dirtyCount > 16 ? `…and ${dirtyCount - 16} more` : '',
        checkpointRefHint(task.id),
      ].filter(Boolean),
    },
    { signal },
  );
  if (outcome === 'APPROVED') return null;

  return refuse(
    outcome === 'REJECTED'
      ? 'Rejected: your uncommitted work in this repository was left untouched.'
      : 'Approval timed out; your uncommitted work was left untouched.',
    true,
  );
}

/**
 * The CLI resolves agents, hooks and MCP servers relative to the project
 * directory, so a repository can redefine the very agent that carries our
 * safety rules — before the agent gets a say. Gate it before launching.
 */
async function approveRepositoryConfig(
  input: Omit<PrepareInput, 'reporter'>,
): Promise<PreparationOutcome | null> {
  const { task, project, config, tasks, approvals, signal } = input;
  const scan = scanRepositoryConfig(project.path, {
    agentName: config.copilot.agent,
    allowRepoInstructions: config.safety.allowRepoInstructions,
  });

  if (scan.notices.length > 0) {
    tasks.addEvent(task.id, 'security', `Repo instruction files ignored: ${scan.notices.map((n) => n.path).join(', ')}`);
  }
  if (scan.blocking.length === 0) return null;

  tasks.addEvent(task.id, 'security', `Repository-supplied Copilot config: ${describeRepoFindings(scan.blocking).join('; ')}`);
  const outcome = await approvals.request(
    {
      taskId: task.id,
      chatId: task.chatId,
      title: 'Repository supplies its own Copilot configuration',
      project: project.name,
      reason:
        'This repository contains Copilot configuration that the CLI loads before the agent runs. ' +
        'It can replace the safety rules this system depends on, or name commands to execute. ' +
        'Approve only if you put these files there yourself.',
      details: describeRepoFindings(scan.blocking),
    },
    { signal },
  );
  if (outcome === 'APPROVED') return null;

  return refuse(
    'Stopped: the repository supplies its own Copilot configuration and it was not approved.\n\n' +
      describeRepoFindings(scan.blocking).join('\n'),
    outcome === 'REJECTED',
  );
}
