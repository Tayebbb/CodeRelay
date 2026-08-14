import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execCommand, type ExecResult } from '../util/exec.js';
import { resolveOnPath } from '../util/which.js';
import { buildChildEnv } from '../copilot/childEnv.js';
export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  head: string | null;
  clean: boolean;
  staged: string[];
  modified: string[];
  untracked: string[];
  /** Conflicted paths. A repository mid-merge must never be worked on. */
  unmerged: string[];
  ahead: number;
  behind: number;
  /**
   * Set when git itself failed. Distinct from "not a repository": reporting a
   * broken git as a clean non-repo would silently disable checkpointing and the
   * dirty-work guard at exactly the moment they are most needed.
   */
  error: string | null;
}

/**
 * Config overrides prepended to EVERY git invocation.
 *
 * `.git/config` and `.git/hooks/` live inside the project directory, so the
 * agent is able to write them — and git will then execute what they name, as
 * the operator, during our own supervising commands. Verified attacks:
 *   - `.git/hooks/post-commit` runs on commit; `--no-verify` does NOT stop it.
 *   - `core.fsmonitor` runs on `git status`.
 * Command-line `-c` beats repository config, so these close the door.
 */
/**
 * Where git is told to look for hooks: a path that is never created.
 *
 * A FIXED path was a mistake. `/remote-agent/no-hooks` resolves on Windows to
 * `<drive>:\remote-agent\no-hooks`, which a standard user can create — and the
 * agent runs as that user. Pre-planting a `post-commit` there would have made
 * every git command in EVERY registered project execute it. The agent can still
 * write anywhere the user can, so the defence is unpredictability: this path is
 * random per process and never written to.
 */
const NO_HOOKS_PATH = path.join(os.tmpdir(), `remote-agent-no-hooks-${randomUUID()}`);

const GIT_HARDENING = [
  '-c',
  `core.hooksPath=${NO_HOOKS_PATH}`,
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
  '-c',
  'core.editor=true',
  '-c',
  'sequence.editor=true',
  '-c',
  'diff.external=',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'uploadpack.packObjectsHook=',
  '-c',
  'core.askPass=',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
  '-c',
  'gpg.program=',
  '-c',
  'gpg.openpgp.program=',
  '-c',
  'gpg.x509.program=',
  '-c',
  'gpg.ssh.program=',
  '-c',
  'core.alternateRefsCommand=',
  '-c',
  'core.gitProxy=',
];

/** Additionally applied to every command except `push`, which needs credentials. */
const GIT_HARDENING_NO_REMOTE = ['-c', 'credential.helper=', '-c', 'core.sshCommand=ssh', '-c', 'ssh.variant=simple'];

/**
 * Absolute path to git, resolved once from PATH.
 *
 * Spawning the bare name `git` with `cwd` set to the target repository executes
 * `<repo>/git.exe` if one exists: Windows searches the current directory first.
 * Verified on this machine — a planted git.exe ran instead of the real one, with
 * the full parent environment, during preflight and before any approval.
 */
let cachedGitPath: string | null | undefined;
function gitProgram(): string {
  if (cachedGitPath === undefined) cachedGitPath = resolveOnPath('git');
  return cachedGitPath ?? 'git';
}

/** Test seam: forget the cached lookup. */
export function resetGitProgramCache(): void {
  cachedGitPath = undefined;
}

/**
 * Config that makes git execute a command while merely READING the worktree.
 *
 * `-c` hardening cannot close these: a filter driver is named by the repository
 * and there is no wildcard to blank them all. Verified attack — a repository
 * shipping `.gitattributes` with `* filter=pwn` and a `filter.pwn.clean`
 * command executed that command during `createCheckpoint()`, i.e. during the
 * step whose whole purpose is to protect the operator's work, before any
 * approval and before the repository scan.
 *
 * Detected by reading files directly, never by asking git, because asking git
 * is itself the dangerous act.
 */
const DANGEROUS_CONFIG_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /^\s*\[\s*filter\s+"/im, what: 'filter driver (runs a command when git reads files)' },
  { re: /^\s*(clean|smudge|process)\s*=/im, what: 'filter clean/smudge/process command' },
  { re: /^\s*\[\s*diff\s+"/im, what: 'diff driver' },
  { re: /^\s*(textconv|command)\s*=/im, what: 'diff textconv/command' },
];

export function detectExecutableGitConfig(root: string, gitDir?: string | null): string[] {
  const dir = gitDir ?? path.join(root, '.git');
  const files = [path.join(dir, 'config'), path.join(dir, 'config.worktree')];

  // Submodules carry their own config with the same power.
  const modules = path.join(dir, 'modules');
  try {
    for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(path.join(modules, entry.name, 'config'));
    }
  } catch {
    // No submodules.
  }

  const findings: string[] = [];
  for (const file of files) {
    let contents: string;
    try {
      contents = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // A filter section is only dangerous when it also names a command, but the
    // section header alone is enough to warrant refusing: it is never something
    // an ordinary checkout needs from an untrusted source.
    const hasSection = /^\s*\[\s*(filter|diff)\s+"/im.test(contents);
    if (!hasSection) continue;
    for (const { re, what } of DANGEROUS_CONFIG_PATTERNS) {
      if (re.test(contents)) findings.push(`${path.relative(root, file) || file}: ${what}`);
    }
  }
  return [...new Set(findings)];
}

export class Git {
  constructor(private readonly cwd: string) {}

  private run(args: string[], env?: NodeJS.ProcessEnv): Promise<ExecResult> {
    // shell:false — git arguments are never interpreted by a shell.
    // buildChildEnv, not process.env: git can be induced to execute repository
    // -supplied commands (filter drivers, and anything a future git version
    // adds), and those must never inherit the bot token or the operator's
    // credentials. Detection is the first line; this is the second.
    return execCommand(gitProgram(), [...GIT_HARDENING, ...GIT_HARDENING_NO_REMOTE, ...args], {
      cwd: this.cwd,
      timeoutMs: 120_000,
      shell: false,
      env: { ...buildChildEnv(process.env, { passthrough: [] }), ...env, GIT_TERMINAL_PROMPT: '0' },
    });
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
      unmerged: [],
      ahead: 0,
      behind: 0,
      error: null,
    };

    const looksLikeRepo = fs.existsSync(path.join(this.cwd, '.git'));
    if (!(await this.isRepository())) {
      // `.git` present but unusable means git is broken here, not that this is
      // an ordinary directory.
      return looksLikeRepo
        ? { ...empty, isRepo: true, clean: false, error: 'a .git entry exists but git cannot read this repository' }
        : empty;
    }

    // core.quotePath=false keeps non-ASCII filenames literal; otherwise git emits
    // C-style escapes wrapped in quotes, which would then be passed to `git add`
    // as a pathspec that matches nothing.
    const result = await this.run([
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all',
    ]);
    if (result.code !== 0) {
      return {
        ...empty,
        isRepo: true,
        clean: false,
        error: `git status failed (exit ${result.code}): ${result.stderr.trim().slice(0, 300)}`,
      };
    }

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
        // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path><TAB><origPath>
        const parts = line.split(' ');
        const xy = parts[1] ?? '..';
        const isRename = line.startsWith('2 ');
        const rest = parts.slice(isRename ? 9 : 8).join(' ');
        const name = isRename ? (rest.split('\t')[0] ?? '') : rest;
        if (!name) continue;
        if (xy[0] !== '.') status.staged.push(name);
        if (xy[1] !== '.') status.modified.push(name);
        // The rename's original path is already recorded as removed in the
        // index; it is not a usable pathspec, so it is deliberately not listed.
      } else if (line.startsWith('u ')) {
        // Unmerged (conflicted) entry:
        // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
        const name = line.split(' ').slice(10).join(' ');
        if (name) {
          status.modified.push(name);
          status.unmerged.push(name);
        }
      } else if (line.startsWith('? ')) {
        status.untracked.push(line.slice(2));
      }
    }

    status.clean = status.staged.length === 0 && status.modified.length === 0 && status.untracked.length === 0;
    return status;
  }

  /** Absolute path of the real git directory (handles worktrees and submodules). */
  async gitDir(): Promise<string | null> {
    const result = await this.run(['rev-parse', '--absolute-git-dir']);
    return result.code === 0 ? result.stdout.trim() : null;
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
      // Never clobber an existing checkpoint: after a crash the task is re-queued
      // and a second checkpoint would capture the half-finished state, destroying
      // the only record of the user's original work.
      const existing = await this.run(['rev-parse', '--verify', '--quiet', ref]);
      const finalRef =
        existing.code === 0 && existing.stdout.trim() ? `${ref}-${Date.now().toString(36)}` : ref;

      const update = await this.run(['update-ref', finalRef, commit]);
      if (update.code !== 0) return null;

      return { ref: finalRef, commit };
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
        if (line !== '') files.add(line);
      }
    }
    return [...files];
  }

  async diffStat(fromCommit: string | null): Promise<string> {
    const args = fromCommit ? ['diff', '--stat', fromCommit] : ['diff', '--stat', 'HEAD'];
    const result = await this.run(args);
    return result.code === 0 ? result.stdout.trim() : '';
  }

  /**
   * Unified diff for review, restricted to an explicit file list so a reviewer
   * can never be shown a file the caller has already screened out.
   */
  async diffUnified(fromCommit: string | null, files: string[], maxBytes = 24_000): Promise<string> {
    if (files.length === 0) return '';
    const base = fromCommit ?? 'HEAD';
    const result = await this.run(['diff', '--unified=3', '--no-color', base, '--', ...files.slice(0, 200)]);
    if (result.code !== 0) return '';
    return result.stdout.length > maxBytes ? `${result.stdout.slice(0, maxBytes)}\n… diff truncated …` : result.stdout;
  }

  /** Total added+removed lines, used as a size signal for confidence scoring. */
  async diffLineCount(fromCommit: string | null): Promise<number> {
    const base = fromCommit ?? 'HEAD';
    const result = await this.run(['diff', '--numstat', base]);
    if (result.code !== 0) return 0;
    let total = 0;
    for (const line of result.stdout.split(/\r?\n/)) {
      const [added, removed] = line.split('\t');
      total += (Number.parseInt(added ?? '', 10) || 0) + (Number.parseInt(removed ?? '', 10) || 0);
    }
    return total;
  }

  /**
   * Stage everything except paths matching the exclusion predicate.
   *
   * Pathspecs go over stdin, not argv: a large refactor can easily exceed the
   * 32 KB Windows command-line limit, and a failed spawn would silently produce
   * an empty commit set.
   */
  async stageAll(exclude: (file: string) => boolean): Promise<string[]> {
    const status = await this.status();
    const candidates = [...new Set([...status.staged, ...status.modified, ...status.untracked])];
    const allowed = candidates.filter((f) => !exclude(f));
    if (allowed.length === 0) return [];

    const add = async (paths: string[]) =>
      execCommand(gitProgram(), [...GIT_HARDENING, ...GIT_HARDENING_NO_REMOTE, 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        cwd: this.cwd,
        timeoutMs: 120_000,
        shell: false,
        stdin: paths.join('\0'),
      });

    const result = await add(allowed);
    if (result.code === 0) return allowed;

    // git aborts the whole invocation on a single unmatched pathspec. Rather
    // than silently produce an empty commit, retry without the paths that can no
    // longer be matched. A tracked-but-deleted path IS still matchable (it
    // stages the deletion), so it must be kept.
    const tracked = await this.run(['ls-files']);
    const trackedSet = new Set(
      tracked.code === 0 ? tracked.stdout.split(/\r?\n/).filter((l) => l !== '') : [],
    );
    const matchable = allowed.filter(
      (f) => fs.existsSync(path.join(this.cwd, f)) || trackedSet.has(f),
    );
    if (matchable.length === 0 || matchable.length === allowed.length) return [];

    const retry = await add(matchable);
    return retry.code === 0 ? matchable : [];
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
    // Credential helpers stay enabled here — pushing needs them — so this is the
    // one command the .git/config integrity gate is solely responsible for.
    // The environment is still the allow-list: a credential helper is a command
    // the repository can name, and it must not be handed the bot token.
    const result = await execCommand(gitProgram(), [...GIT_HARDENING, 'push', 'origin', branch], {
      cwd: this.cwd,
      timeoutMs: 120_000,
      shell: false,
      env: { ...buildChildEnv(process.env, { passthrough: [] }), GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: result.code === 0, output: result.stdout + result.stderr };
  }

  async hasRemote(): Promise<boolean> {
    const result = await this.run(['remote']);
    return result.code === 0 && result.stdout.trim().length > 0;
  }

  /**
   * Delete checkpoint refs older than `maxAgeMs`, always keeping the newest
   * `keep`. Each ref pins a whole tree, so without this the agent would grow the
   * user's repositories without bound.
   */
  async pruneCheckpoints(maxAgeMs: number, keep = 10): Promise<number> {
    if (!(await this.isRepository())) return 0;
    const listed = await this.run([
      'for-each-ref',
      '--format=%(refname) %(committerdate:unix)',
      'refs/remote-agent/',
    ]);
    if (listed.code !== 0) return 0;

    const refs = listed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [ref, ts] = line.split(' ');
        return { ref: ref ?? '', at: Number.parseInt(ts ?? '0', 10) * 1000 };
      })
      .filter((entry) => entry.ref)
      .sort((a, b) => b.at - a.at);

    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const entry of refs.slice(keep)) {
      if (entry.at >= cutoff) continue;
      const result = await this.run(['update-ref', '-d', entry.ref]);
      if (result.code === 0) removed += 1;
    }
    return removed;
  }

  /** Remove alternate index files left behind by a killed checkpoint. */
  async sweepStaleIndexFiles(): Promise<void> {
    const gitDirResult = await this.run(['rev-parse', '--absolute-git-dir']);
    if (gitDirResult.code !== 0) return;
    const gitDir = gitDirResult.stdout.trim();
    try {
      for (const name of fs.readdirSync(gitDir)) {
        if (name.startsWith('remote-agent-checkpoint-') && name.endsWith('.index')) {
          fs.rmSync(path.join(gitDir, name), { force: true });
        }
      }
    } catch {
      // best effort
    }
  }
}
