/**
 * Turning a verified working tree into a commit, and optionally a push.
 *
 * Separated from the agent loop because this is the second place where
 * irreversible things happen. Two rules matter more than the mechanics:
 *   - only files the agent actually changed are staged, never the operator's
 *     own uncommitted work that happened to be sitting in the tree
 *   - a protected branch and a push each need explicit human approval
 */

import type { AppConfig } from '../core/config.js';
import { isSensitiveFile } from '../core/redact.js';
import type { TaskRepository } from '../db/taskRepository.js';
import type { Task } from '../domain/task.js';
import type { ProjectRecord } from '../projects/registry.js';
import type { Git } from '../git/git.js';
import { tailLines } from '../util/exec.js';
import type { ApprovalService } from '../approval/service.js';
import type { ProgressReporter } from '../notify/notifier.js';

/** How many changed files to show in an approval prompt before truncating. */
const APPROVAL_FILE_PREVIEW = 15;

export interface PublishInput {
  task: Task;
  project: ProjectRecord;
  config: AppConfig;
  tasks: TaskRepository;
  approvals: ApprovalService;
  reporter: ProgressReporter;
  signal: AbortSignal;
  git: Git;
  branch: string | null;
  /** Files the agent changed, already screened for sensitive paths. */
  changedFiles: string[];
  commitMessage: string;
}

export interface PublishResult {
  commitHash: string | null;
  pushed: boolean;
}

/** Stage and commit the agent's own changes, then push if configured and approved. */
export async function publishChanges(input: PublishInput): Promise<PublishResult> {
  const { task, project, config, tasks, approvals, reporter, signal, git, branch, changedFiles } = input;

  if (!(await approveProtectedBranch(input))) return { commitHash: null, pushed: false };

  await reporter.milestone('📦 Creating commit…');
  const agentChanged = new Set(changedFiles);
  const staged = await git.stageAll((file) => isSensitiveFile(file) || !agentChanged.has(file));
  if (staged.length === 0 || !(await git.hasStagedChanges())) return { commitHash: null, pushed: false };

  const commit = await git.commit(input.commitMessage);
  if (!commit.ok) {
    tasks.addEvent(task.id, 'git', `Commit failed: ${tailLines(commit.output, 3)}`);
    return { commitHash: null, pushed: false };
  }

  const commitHash = commit.hash;
  tasks.addEvent(task.id, 'git', `Committed ${commitHash?.slice(0, 8)}`);

  if (!commitHash || !config.git.autoPush || !branch) return { commitHash, pushed: false };

  const outcome = await approvals.request(
    {
      taskId: task.id,
      chatId: task.chatId,
      title: 'Push to remote',
      project: project.name,
      reason: `AUTO_PUSH is enabled. Push ${commitHash.slice(0, 8)} to origin/${branch}?`,
      details: changedFiles.slice(0, APPROVAL_FILE_PREVIEW),
    },
    { signal },
  );
  if (outcome !== 'APPROVED') return { commitHash, pushed: false };

  const push = await git.push(branch);
  tasks.addEvent(task.id, 'git', push.ok ? 'Pushed to origin' : `Push failed: ${tailLines(push.output, 3)}`);
  await reporter.milestone(push.ok ? '⬆️ Pushed to origin' : '⚠️ Push failed');
  return { commitHash, pushed: push.ok };
}

async function approveProtectedBranch(input: PublishInput): Promise<boolean> {
  const { task, project, config, tasks, approvals, reporter, signal, branch, changedFiles } = input;
  const isProtected = branch !== null && config.git.protectedBranches.includes(branch);
  if (!isProtected || !config.safety.requireApprovalForDangerousActions) return true;

  reporter.update(`⚠️ Branch "${branch}" is protected — asking for approval to commit…`);
  const outcome = await approvals.request(
    {
      taskId: task.id,
      chatId: task.chatId,
      title: 'Commit to a protected branch',
      project: project.name,
      reason: `Branch "${branch}" is listed in PROTECTED_BRANCHES.`,
      details: changedFiles.slice(0, APPROVAL_FILE_PREVIEW),
    },
    { signal },
  );
  if (outcome === 'APPROVED') return true;

  tasks.addEvent(task.id, 'git', 'Commit to protected branch declined');
  return false;
}
