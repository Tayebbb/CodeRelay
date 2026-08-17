/**
 * Operator-initiated git operations — the "git remote control".
 *
 * This is a fixed menu (fetch / pull / push / sync), never arbitrary git. The
 * operator pressing a button in an authenticated interface IS the approval, so
 * there is no extra approval hop — but every safety property of the task flow
 * still holds: filter-driver detection before any git command, the hardened
 * Git wrapper, redaction of everything sent back, and refusal to touch a
 * repository an agent task is currently working in.
 *
 * Pull is `--ff-only` on purpose: from a phone there is no way to resolve a
 * merge, so an operation that could create conflict markers must not exist.
 */

import { detectExecutableGitConfig, Git } from '../git/git.js';
import type { ProjectRecord, ProjectRegistry } from '../projects/registry.js';
import type { TaskRepository } from '../db/taskRepository.js';
import { redact } from './redact.js';
import { tailLines } from '../util/exec.js';
import { createLogger } from './logger.js';

const log = createLogger('git-control');

export const GIT_ACTIONS = ['fetch', 'pull', 'push', 'sync'] as const;
export type GitAction = (typeof GIT_ACTIONS)[number];

export function isGitAction(value: string): value is GitAction {
  return (GIT_ACTIONS as readonly string[]).includes(value);
}

/** What the panel shows. Counts only — never filesystem paths. */
export interface GitPanel {
  projectId: string;
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  dirty: number;
  hasRemote: boolean;
  error: string | null;
}

export type GitResult = { ok: boolean; message: string };

export interface GitControlDeps {
  projects: ProjectRegistry;
  tasks: TaskRepository;
}

export class GitControlService {
  /** One remote operation per project at a time. */
  private readonly busy = new Set<string>();

  constructor(private readonly deps: GitControlDeps) {}

  /** Null when the project is not registered. */
  async status(projectId: string): Promise<GitPanel | null> {
    const project = this.project(projectId);
    if (!project) return null;

    const blocked = this.executableConfig(project);
    if (blocked) {
      return { projectId, isRepo: true, branch: null, ahead: 0, behind: 0, dirty: 0, hasRemote: false, error: blocked };
    }

    const git = new Git(project.path);
    const s = await git.status();
    if (!s.isRepo) {
      return { projectId, isRepo: false, branch: null, ahead: 0, behind: 0, dirty: 0, hasRemote: false, error: null };
    }
    return {
      projectId,
      isRepo: true,
      branch: s.branch,
      ahead: s.ahead,
      behind: s.behind,
      dirty: s.staged.length + s.modified.length + s.untracked.length,
      hasRemote: await git.hasRemote(),
      error: s.error,
    };
  }

  async run(projectId: string, action: GitAction): Promise<GitResult> {
    const project = this.project(projectId);
    if (!project) return { ok: false, message: 'That project is not registered.' };

    const blocked = this.executableConfig(project);
    if (blocked) return { ok: false, message: blocked };

    // Sharing a working tree with a live agent task invites exactly the
    // corruption the per-project queue serialization exists to prevent.
    const active = ['RUNNING', 'TESTING'] as const;
    for (const status of active) {
      const task = this.deps.tasks.listByStatus(status).find((t) => t.projectId === projectId);
      if (task) return { ok: false, message: `Task #${task.id} is working in this repository — wait for it to finish.` };
    }

    if (this.busy.has(projectId)) {
      return { ok: false, message: 'Another git operation is already running for this project.' };
    }
    this.busy.add(projectId);
    try {
      const git = new Git(project.path);
      if (!(await git.isRepository())) return { ok: false, message: 'This project is not a git repository.' };
      if (!(await git.hasRemote())) return { ok: false, message: 'This repository has no remote configured.' };

      log.info('Operator git action', { projectId, action });
      switch (action) {
        case 'fetch': {
          const result = await git.fetch();
          if (!result.ok) return this.failure('Fetch failed', result.output);
          const after = await git.status();
          return { ok: true, message: `Fetched. ${this.position(after.ahead, after.behind)}` };
        }
        case 'pull':
          return await this.pull(git);
        case 'push':
          return await this.push(git);
        case 'sync': {
          const pulled = await this.pull(git);
          if (!pulled.ok) return pulled;
          const pushed = await this.push(git);
          return pushed.ok ? { ok: true, message: `${pulled.message} ${pushed.message}` } : pushed;
        }
      }
    } catch (err) {
      return this.failure(`${action} failed`, String(err));
    } finally {
      this.busy.delete(projectId);
    }
  }

  private async pull(git: Git): Promise<GitResult> {
    const result = await git.pullFfOnly();
    if (result.ok) {
      return { ok: true, message: /already up to date/i.test(result.output) ? 'Already up to date.' : 'Pulled.' };
    }
    if (/not possible to fast-forward|have diverged|divergent/i.test(result.output)) {
      return {
        ok: false,
        message:
          'Pull refused: the local and remote branches have diverged. ' +
          'Nothing was changed — resolve this on the PC, where a merge can be reviewed.',
      };
    }
    if (/would be overwritten|commit your changes or stash/i.test(result.output)) {
      return {
        ok: false,
        message: 'Pull refused: uncommitted local changes would be overwritten. Nothing was changed.',
      };
    }
    return this.failure('Pull failed', result.output);
  }

  private async push(git: Git): Promise<GitResult> {
    const status = await git.status();
    if (!status.branch) return { ok: false, message: 'Push refused: not on a branch (detached HEAD).' };
    const result = await git.push(status.branch);
    if (!result.ok) return this.failure('Push failed', result.output);
    return { ok: true, message: /everything up.to.date/i.test(result.output) ? 'Nothing to push.' : 'Pushed.' };
  }

  private failure(prefix: string, output: string): GitResult {
    return { ok: false, message: `${prefix}:\n${redact(tailLines(output, 4))}` };
  }

  private position(ahead: number, behind: number): string {
    if (ahead === 0 && behind === 0) return 'In sync with the remote.';
    const parts = [];
    if (ahead > 0) parts.push(`${ahead} commit(s) to push`);
    if (behind > 0) parts.push(`${behind} to pull`);
    return parts.join(', ') + '.';
  }

  private project(projectId: string): ProjectRecord | null {
    this.deps.projects.load();
    return this.deps.projects.getById(projectId);
  }

  private executableConfig(project: ProjectRecord): string | null {
    const findings = detectExecutableGitConfig(project.path, null);
    if (findings.length === 0) return null;
    return (
      'Refusing: this repository configures git to run commands when it merely reads files:\n' +
      findings.slice(0, 5).map((f) => `  - ${f}`).join('\n')
    );
  }
}
