import path from 'node:path';
import fs from 'node:fs';
import { execCommand, type ExecResult } from '../util/exec.js';

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  head: string | null;
  clean: boolean;
  staged: string[];
  modified: string[];
  untracked: string[];
  ahead: number;
  behind: number;
}

export class Git {
  constructor(private readonly cwd: string) {}

  private run(args: string[], env?: NodeJS.ProcessEnv): Promise<ExecResult> {
    // shell:false — git arguments are never interpreted by a shell.
    return execCommand('git', args, { cwd: this.cwd, timeoutMs: 120_000, shell: false, env });
  }

  async isRepository(): Promise<boolean> {
    if (!fs.existsSync(path.join(this.cwd, '.git'))) {
      const result = await this.run(['rev-parse', '--is-inside-work-tree']);
      return result.code === 0 && result.stdout.trim() === 'true';
    }
    return true;
  }

  async status(): Promise<GitStatus> {
    const empty: GitStatus = {
      isRepo: false,
      branch: null,
      head: null,
      clean: true,
      staged: [],
      modified: [],
      untracked: [],
      ahead: 0,
      behind: 0,
    };

    if (!(await this.isRepository())) return empty;

    const result = await this.run(['status', '--porcelain=v2', '--branch', '--untracked-files=all']);
    if (result.code !== 0) return empty;

    const status: GitStatus = { ...empty, isRepo: true };

    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith('# branch.head ')) {
        const value = line.slice('# branch.head '.length).trim();
        status.branch = value === '(detached)' ? null : value;
      } else if (line.startsWith('# branch.oid ')) {
        const value = line.slice('# branch.oid '.length).trim();
        status.head = value === '(initial)' ? null : value;
      } else if (line.startsWith('# branch.ab ')) {
        const match = /\+(\d+)\s+-(\d+)/.exec(line);
        if (match) {
          status.ahead = Number.parseInt(match[1]!, 10);
          status.behind = Number.parseInt(match[2]!, 10);
        }
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        // "1 <XY> ... <path>"
        const parts = line.split(' ');
        const xy = parts[1] ?? '..';
        const filePath = line.slice(line.indexOf(' ', line.indexOf(' ') + 1)).trim().split('\t').pop() ?? '';
        const name = parts.slice(8).join(' ') || filePath;
        if (xy[0] !== '.') status.staged.push(name);
        if (xy[1] !== '.') status.modified.push(name);
      } else if (line.startsWith('? ')) {
        status.untracked.push(line.slice(2).trim());
      }
    }

    status.clean = status.staged.length === 0 && status.modified.length === 0 && status.untracked.length === 0;
    return status;
  }

  async currentBranch(): Promise<string | null> {
    const result = await this.run(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (result.code !== 0) return null;
    const branch = result.stdout.trim();
    return branch === 'HEAD' ? null : branch;
  }

  async headCommit(): Promise<string | null> {
    const result = await this.run(['rev-parse', 'HEAD']);
    return result.code === 0 ? result.stdout.trim() : null;
  }

  /**
   * Snapshot the working tree (including untracked files) into a real commit
   * object WITHOUT touching the user's index or working tree.
   *
   * It writes to an alternate index via GIT_INDEX_FILE, so `git add` here cannot
   * disturb anything the user has staged. The result is tagged so the user can
   * always recover with `git checkout <tag> -- .`.
   */
  async createCheckpoint(taskId: number): Promise<{ ref: string; commit: string } | null> {
    if (!(await this.isRepository())) return null;

    const head = await this.headCommit();
    if (!head) return null; // no commits yet; nothing to diff against

    const gitDirResult = await this.run(['rev-parse', '--absolute-git-dir']);
    if (gitDirResult.code !== 0) return null;
    const gitDir = gitDirResult.stdout.trim();
    const altIndex = path.join(gitDir, `remote-agent-checkpoint-${taskId}.index`);

    try {
      fs.rmSync(altIndex, { force: true });
      const env = { GIT_INDEX_FILE: altIndex };

      const readTree = await this.run(['read-tree', 'HEAD'], env);
      if (readTree.code !== 0) return null;

      const add = await this.run(['add', '-A', '--', '.'], env);
      if (add.code !== 0) return null;

      const writeTree = await this.run(['write-tree'], env);
      if (writeTree.code !== 0) return null;
      const tree = writeTree.stdout.trim();

      const commitTree = await this.run(
        ['commit-tree', tree, '-p', head, '-m', `remote-agent checkpoint before task #${taskId}`],
        {
          ...env,
          GIT_AUTHOR_NAME: 'remote-agent',
          GIT_AUTHOR_EMAIL: 'remote-agent@localhost',
          GIT_COMMITTER_NAME: 'remote-agent',
          GIT_COMMITTER_EMAIL: 'remote-agent@localhost',
        },
      );
      if (commitTree.code !== 0) return null;
      const commit = commitTree.stdout.trim();

      const ref = `refs/remote-agent/checkpoint-${taskId}`;
      const update = await this.run(['update-ref', ref, commit]);
      if (update.code !== 0) return null;

      return { ref, commit };
    } finally {
      fs.rmSync(altIndex, { force: true });
    }
  }

  async diffNameOnly(fromCommit: string | null): Promise<string[]> {
    const args = fromCommit
      ? ['diff', '--name-only', fromCommit, '--']
      : ['diff', '--name-only', 'HEAD', '--'];
    const tracked = await this.run(args);
    const untracked = await this.run(['ls-files', '--others', '--exclude-standard']);
    const files = new Set<string>();
    for (const source of [tracked, untracked]) {
      if (source.code !== 0) continue;
      for (const line of source.stdout.split(/\r?\n/)) {
        if (line.trim()) files.add(line.trim());
      }
    }
    return [...files];
  }

  async diffStat(fromCommit: string | null): Promise<string> {
    const args = fromCommit ? ['diff', '--stat', fromCommit] : ['diff', '--stat', 'HEAD'];
    const result = await this.run(args);
    return result.code === 0 ? result.stdout.trim() : '';
  }

  /** Stage everything except paths matching the exclusion predicate. */
  async stageAll(exclude: (file: string) => boolean): Promise<string[]> {
    const status = await this.status();
    const candidates = [...new Set([...status.staged, ...status.modified, ...status.untracked])];
    const allowed = candidates.filter((f) => !exclude(f));
    if (allowed.length === 0) return [];

    // `--` guards against a file named like an option.
    const result = await this.run(['add', '--', ...allowed]);
    return result.code === 0 ? allowed : [];
  }

  async commit(message: string): Promise<{ ok: boolean; hash: string | null; output: string }> {
    const result = await this.run(['commit', '-m', message, '--no-verify']);
    if (result.code !== 0) {
      return { ok: false, hash: null, output: result.stdout + result.stderr };
    }
    const hash = await this.headCommit();
    return { ok: true, hash, output: result.stdout };
  }

  async hasStagedChanges(): Promise<boolean> {
    const result = await this.run(['diff', '--cached', '--name-only']);
    return result.code === 0 && result.stdout.trim().length > 0;
  }

  async push(branch: string): Promise<{ ok: boolean; output: string }> {
    const result = await this.run(['push', 'origin', branch]);
    return { ok: result.code === 0, output: result.stdout + result.stderr };
  }

  async hasRemote(): Promise<boolean> {
    const result = await this.run(['remote']);
    return result.code === 0 && result.stdout.trim().length > 0;
  }
}
