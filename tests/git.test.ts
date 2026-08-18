import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Git } from '../src/git/git.js';
import { GitControlService } from '../src/core/gitControl.js';
import { ProjectRegistry } from '../src/projects/registry.js';
import { TaskRepository } from '../src/db/taskRepository.js';
import { openDatabase } from '../src/db/database.js';
import { execCommand } from '../src/util/exec.js';

let repoDir: string;

async function git(args: string[]) {
  return execCommand('git', args, { cwd: repoDir, shell: false, timeoutMs: 30_000 });
}

before(async () => {
  repoDir = path.join(os.tmpdir(), `rpca-git-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(repoDir, { recursive: true });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# demo\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'initial']);
});

after(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('git remote control primitives', () => {
  let base: string;
  let origin: string;
  let cloneA: string;
  let cloneB: string;

  async function sh(cwd: string, args: string[]) {
    return execCommand('git', args, { cwd, shell: false, timeoutMs: 30_000 });
  }

  async function commitFile(cwd: string, name: string, content: string) {
    fs.writeFileSync(path.join(cwd, name), content);
    await sh(cwd, ['add', '.']);
    await sh(cwd, ['commit', '-m', `add ${name}`]);
  }

  before(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'rpca-remote-'));
    origin = path.join(base, 'origin.git');
    cloneA = path.join(base, 'a');
    cloneB = path.join(base, 'b');
    fs.mkdirSync(origin, { recursive: true });
    await sh(origin, ['init', '--bare', '-b', 'main']);
    for (const clone of [cloneA, cloneB]) {
      await execCommand('git', ['clone', origin, clone], { cwd: base, shell: false, timeoutMs: 30_000 });
      await sh(clone, ['config', 'user.email', 'test@example.com']);
      await sh(clone, ['config', 'user.name', 'Test']);
      await sh(clone, ['config', 'commit.gpgsign', 'false']);
    }
    await commitFile(cloneA, 'README.md', '# shared\n');
    await sh(cloneA, ['push', 'origin', 'main']);
    await sh(cloneB, ['pull', 'origin', 'main']);
    await sh(cloneB, ['branch', '--set-upstream-to=origin/main', 'main']);
  });

  after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  test('fetch updates tracking refs without touching the working tree', async () => {
    await commitFile(cloneA, 'one.txt', '1\n');
    await sh(cloneA, ['push', 'origin', 'main']);

    const result = await new Git(cloneB).fetch();
    assert.equal(result.ok, true, result.output);
    assert.ok(!fs.existsSync(path.join(cloneB, 'one.txt')), 'fetch must not modify files');
    const status = await new Git(cloneB).status();
    assert.equal(status.behind, 1);
  });

  test('pull fast-forwards when possible', async () => {
    const result = await new Git(cloneB).pullFfOnly();
    assert.equal(result.ok, true, result.output);
    assert.ok(fs.existsSync(path.join(cloneB, 'one.txt')));
  });

  test('pull refuses divergence instead of creating a merge or conflict', async () => {
    await commitFile(cloneA, 'two.txt', 'from A\n');
    await sh(cloneA, ['push', 'origin', 'main']);
    await commitFile(cloneB, 'local.txt', 'from B\n');

    const headBefore = (await sh(cloneB, ['rev-parse', 'HEAD'])).stdout.trim();
    const result = await new Git(cloneB).pullFfOnly();
    assert.equal(result.ok, false, 'diverged branches must not fast-forward');
    const headAfter = (await sh(cloneB, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.equal(headAfter, headBefore, 'the local branch is untouched');
    assert.ok(!fs.existsSync(path.join(cloneB, 'two.txt')), 'no partial merge appeared');
    assert.ok(fs.readFileSync(path.join(cloneB, 'local.txt'), 'utf8').includes('from B'));
  });

  test('push uploads local commits', async () => {
    await commitFile(cloneA, 'three.txt', '3\n');
    const result = await new Git(cloneA).push('main');
    assert.equal(result.ok, true, result.output);
    const remoteHas = await sh(origin, ['rev-parse', 'refs/heads/main']);
    const localHead = await sh(cloneA, ['rev-parse', 'HEAD']);
    assert.equal(remoteHas.stdout.trim(), localHead.stdout.trim());
  });
});

describe('git controller commit', () => {
  let dir: string;
  let service: GitControlService;
  let db: ReturnType<typeof openDatabase>;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpca-commit-'));
    const repo = path.join(dir, 'work');
    fs.mkdirSync(repo);
    const sh = (args: string[]) => execCommand('git', args, { cwd: repo, shell: false, timeoutMs: 30_000 });
    await sh(['init', '-b', 'main']);
    await sh(['config', 'user.email', 'test@example.com']);
    await sh(['config', 'user.name', 'Test']);
    await sh(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    await sh(['add', '.']);
    await sh(['commit', '-m', 'initial']);

    const registryFile = path.join(dir, 'projects.json');
    fs.writeFileSync(registryFile, JSON.stringify({ projects: [{ id: 'work', name: 'Work', path: repo }] }));
    const projects = new ProjectRegistry(registryFile);
    projects.load();
    db = openDatabase(':memory:');
    service = new GitControlService({ projects, tasks: new TaskRepository(db) });
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('commits dirty work but never protected files', async () => {
    const repo = path.join(dir, 'work');
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'hello\n');
    fs.writeFileSync(path.join(repo, '.env'), 'API_KEY=supersecret\n');

    const result = await service.run('work', 'commit', { message: 'add notes' });
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /1 protected file\(s\) were left uncommitted/);

    const shown = await execCommand('git', ['show', '--stat', 'HEAD'], { cwd: repo, shell: false, timeoutMs: 30_000 });
    assert.ok(shown.stdout.includes('notes.txt'));
    assert.ok(!shown.stdout.includes('.env'), 'the secret file must never enter history');
    assert.ok(shown.stdout.includes('add notes'));
    assert.ok(fs.existsSync(path.join(repo, '.env')), 'the secret file itself is untouched');
  });

  test('a clean tree has nothing to commit', async () => {
    // Only the protected .env remains uncommitted from the previous test.
    const result = await service.run('work', 'commit');
    assert.equal(result.ok, false);
    assert.match(result.message, /protected files|clean/);
  });
});

describe('git safety', () => {
  test('detects a clean repository', async () => {
    const status = await new Git(repoDir).status();
    assert.equal(status.isRepo, true);
    assert.equal(status.clean, true);
    assert.equal(status.branch, 'main');
    assert.ok(status.head);
  });

  test('detects uncommitted and untracked work', async () => {
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# demo\nedited by the user\n');
    fs.writeFileSync(path.join(repoDir, 'scratch.txt'), 'user notes\n');

    const status = await new Git(repoDir).status();
    assert.equal(status.clean, false);
    assert.ok(status.modified.includes('README.md'), 'modified file detected');
    assert.ok(status.untracked.includes('scratch.txt'), 'untracked file detected');
  });

  test('checkpoint captures uncommitted work without touching the worktree or index', async () => {
    const gitApi = new Git(repoDir);
    const before = await gitApi.status();
    const beforeReadme = fs.readFileSync(path.join(repoDir, 'README.md'), 'utf8');

    const checkpoint = await gitApi.createCheckpoint(42);
    assert.ok(checkpoint, 'a checkpoint object is created');
    assert.match(checkpoint!.ref, /^refs\/remote-agent\/checkpoint-42$/);

    // The user's working tree is untouched...
    assert.equal(fs.readFileSync(path.join(repoDir, 'README.md'), 'utf8'), beforeReadme);
    // ...and nothing became staged behind their back.
    const after = await gitApi.status();
    assert.deepEqual(after.staged, before.staged);
    assert.equal(after.clean, false);

    // The checkpoint really contains the user's edits, so it is recoverable.
    const show = await git(['show', `${checkpoint!.commit}:README.md`]);
    assert.ok(show.stdout.includes('edited by the user'));

    const untracked = await git(['show', `${checkpoint!.commit}:scratch.txt`]);
    assert.ok(untracked.stdout.includes('user notes'), 'untracked files are preserved too');
  });

  test('checkpoint leaves no stray index file behind', async () => {
    const entries = fs.readdirSync(path.join(repoDir, '.git'));
    assert.ok(!entries.some((f) => f.includes('remote-agent-checkpoint')));
  });

  test('staging excludes sensitive files', async () => {
    fs.writeFileSync(path.join(repoDir, '.env'), 'API_KEY=supersecret\n');
    fs.writeFileSync(path.join(repoDir, 'app.js'), 'console.log(1)\n');

    const gitApi = new Git(repoDir);
    const staged = await gitApi.stageAll((file) => file === '.env' || file.endsWith('/.env'));

    assert.ok(staged.includes('app.js'));
    assert.ok(!staged.includes('.env'), '.env must never be staged');

    const cached = await git(['diff', '--cached', '--name-only']);
    assert.ok(!cached.stdout.includes('.env'));
  });

  test('lists changed files relative to a base commit', async () => {
    const gitApi = new Git(repoDir);
    const head = await gitApi.headCommit();
    fs.writeFileSync(path.join(repoDir, 'new-feature.ts'), 'export const x = 1;\n');
    const changed = await gitApi.diffNameOnly(head);
    assert.ok(changed.includes('new-feature.ts'));
  });

  test('reports non-repositories safely instead of throwing', async () => {
    const plain = path.join(os.tmpdir(), `rpca-plain-${Date.now()}`);
    fs.mkdirSync(plain, { recursive: true });
    const status = await new Git(plain).status();
    assert.equal(status.isRepo, false);
    assert.equal(await new Git(plain).createCheckpoint(1), null);
    fs.rmSync(plain, { recursive: true, force: true });
  });
});

describe('git status parsing edge cases', () => {
  let repo2: string;

  async function git2(args: string[]) {
    return execCommand('git', args, { cwd: repo2, shell: false, timeoutMs: 60_000 });
  }

  before(async () => {
    repo2 = path.join(os.tmpdir(), `rpca-git2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(repo2, { recursive: true });
    await git2(['init', '-b', 'main']);
    await git2(['config', 'user.email', 'test@example.com']);
    await git2(['config', 'user.name', 'Test']);
    await git2(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo2, 'original.ts'), 'export const a = 1;\n');
    await git2(['add', '.']);
    await git2(['commit', '-m', 'initial']);
  });

  after(() => {
    fs.rmSync(repo2, { recursive: true, force: true });
  });

  test('a renamed file is staged under its new path, not a mangled score string', async () => {
    const gitApi = new Git(repo2);
    await git2(['mv', 'original.ts', 'renamed.ts']);

    const status = await gitApi.status();
    // A porcelain-v2 "2 " record puts a rename score where an ordinary record
    // puts the path; mis-parsing yields "R100 renamed.ts<TAB>original.ts", which
    // git then rejects as a pathspec — killing the whole commit.
    assert.ok(status.staged.includes('renamed.ts'), `staged was ${JSON.stringify(status.staged)}`);
    assert.ok(!status.staged.some((f) => /^R\d/.test(f)), 'no rename score leaked into a path');
    assert.ok(!status.staged.some((f) => f.includes('\t')), 'no tab-joined path pair leaked');

    const staged = await gitApi.stageAll(() => false);
    assert.ok(staged.includes('renamed.ts'));
    assert.ok(await gitApi.hasStagedChanges(), 'the rename must actually reach the index');
  });

  test('handles non-ASCII filenames without quoting artefacts', async () => {
    const gitApi = new Git(repo2);
    fs.writeFileSync(path.join(repo2, 'café-données.ts'), 'export const b = 2;\n');

    const status = await gitApi.status();
    assert.ok(
      status.untracked.includes('café-données.ts'),
      `untracked was ${JSON.stringify(status.untracked)}`,
    );

    const staged = await gitApi.stageAll(() => false);
    assert.ok(staged.includes('café-données.ts'));
    assert.ok(await gitApi.hasStagedChanges());
  });

  test('stages far more files than fit on a command line', async () => {
    const gitApi = new Git(repo2);
    const dir = path.join(repo2, 'bulk');
    fs.mkdirSync(dir, { recursive: true });

    // Comfortably beyond the 32 KB Windows command-line limit as argv.
    const count = 600;
    const longName = 'a'.repeat(60);
    for (let i = 0; i < count; i += 1) {
      fs.writeFileSync(path.join(dir, `${longName}-${i}.ts`), 'export const x = 1;\n');
    }

    const staged = await gitApi.stageAll(() => false);
    assert.ok(staged.length >= count, `expected >= ${count} staged, got ${staged.length}`);

    const cached = await git2(['diff', '--cached', '--name-only']);
    assert.ok(cached.stdout.split(/\r?\n/).filter(Boolean).length >= count, 'all files reached the index');
  });

  test('a second checkpoint does not overwrite the first', async () => {
    const gitApi = new Git(repo2);
    const first = await gitApi.createCheckpoint(77);
    assert.ok(first);

    fs.writeFileSync(path.join(repo2, 'later.ts'), 'export const c = 3;\n');
    const second = await gitApi.createCheckpoint(77);
    assert.ok(second);

    assert.notEqual(second!.ref, first!.ref, 'the original recovery point must survive a re-run');
    const original = await git2(['rev-parse', first!.ref]);
    assert.equal(original.stdout.trim(), first!.commit);
  });

  test('stages a deletion the agent made', async () => {
    const gitApi = new Git(repo2);
    await git2(['add', '.']);
    await git2(['commit', '-m', 'baseline for deletion test']);

    fs.rmSync(path.join(repo2, 'later.ts'));
    const status = await gitApi.status();
    assert.ok(status.modified.includes('later.ts'), 'a deleted tracked file is a change');

    const staged = await gitApi.stageAll(() => false);
    assert.ok(staged.includes('later.ts'), 'the deletion must reach the index, not be silently dropped');

    const cached = await git2(['diff', '--cached', '--name-status']);
    assert.match(cached.stdout, /D\s+later\.ts/);
  });

  test('detects unmerged paths so a conflicted repo is never reported clean', async () => {
    const conflict = path.join(os.tmpdir(), `rpca-conflict-${Date.now()}`);
    fs.mkdirSync(conflict, { recursive: true });
    const run = (args: string[]) => execCommand('git', args, { cwd: conflict, shell: false, timeoutMs: 30_000 });

    await run(['init', '-b', 'main']);
    await run(['config', 'user.email', 't@e.com']);
    await run(['config', 'user.name', 'T']);
    await run(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(conflict, 'f.txt'), 'base\n');
    await run(['add', '.']);
    await run(['commit', '-m', 'base']);

    await run(['checkout', '-b', 'side']);
    fs.writeFileSync(path.join(conflict, 'f.txt'), 'side\n');
    await run(['commit', '-am', 'side']);
    await run(['checkout', 'main']);
    fs.writeFileSync(path.join(conflict, 'f.txt'), 'main\n');
    await run(['commit', '-am', 'main']);
    await run(['merge', 'side']);

    const status = await new Git(conflict).status();
    assert.ok(status.unmerged.includes('f.txt'), `unmerged was ${JSON.stringify(status.unmerged)}`);
    assert.equal(status.clean, false);

    fs.rmSync(conflict, { recursive: true, force: true });
  });
});
