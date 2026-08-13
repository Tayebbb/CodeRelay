import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Git } from '../src/git/git.js';
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
