import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectCommands, parseOverride } from '../src/verify/detector.js';
import { parseNaturalTask, splitTaskCommand } from '../src/telegram/nlp.js';
import { buildTaskPrompt } from '../src/runner/promptBuilder.js';
import { loadConfig, ConfigError } from '../src/core/config.js';
import type { ProjectRecord } from '../src/projects/registry.js';

function scratch(files: Record<string, string>): string {
  const dir = path.join(os.tmpdir(), `rpca-detect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe('test and build command detection', () => {
  test('uses package.json scripts', () => {
    const dir = scratch({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc' } }),
    });
    const commands = detectCommands(dir);
    assert.equal(commands.find((c) => c.kind === 'test')?.command, 'npm');
    assert.ok(commands.find((c) => c.kind === 'build')?.display.includes('build'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('respects the pnpm lockfile', () => {
    const dir = scratch({
      'package.json': JSON.stringify({ scripts: { test: 'jest' } }),
      'pnpm-lock.yaml': '',
    });
    assert.equal(detectCommands(dir).find((c) => c.kind === 'test')?.command, 'pnpm');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('detects maven projects', () => {
    const dir = scratch({ 'pom.xml': '<project/>' });
    const commands = detectCommands(dir);
    assert.ok(commands.find((c) => c.kind === 'test')?.display.startsWith('mvn'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('detects python projects', () => {
    const dir = scratch({ 'pyproject.toml': '[project]\nname="x"\n' });
    assert.ok(detectCommands(dir).find((c) => c.kind === 'test')?.display.includes('pytest'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('detects go and rust projects', () => {
    const goDir = scratch({ 'go.mod': 'module x\n' });
    assert.equal(detectCommands(goDir).find((c) => c.kind === 'test')?.command, 'go');
    fs.rmSync(goDir, { recursive: true, force: true });

    const rustDir = scratch({ 'Cargo.toml': '[package]\nname="x"\n' });
    assert.equal(detectCommands(rustDir).find((c) => c.kind === 'test')?.command, 'cargo');
    fs.rmSync(rustDir, { recursive: true, force: true });
  });

  test('invents nothing when the project declares nothing', () => {
    const dir = scratch({ 'notes.txt': 'hello' });
    assert.deepEqual(detectCommands(dir), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('registry overrides win over detection', () => {
    const dir = scratch({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) });
    const commands = detectCommands(dir, { testCommand: 'npm run test:ci' });
    assert.equal(commands.find((c) => c.kind === 'test')?.display, 'npm run test:ci');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('splits overrides into argv without a shell', () => {
    const parsed = parseOverride('test', 'npm run "test:all" -- --ci');
    assert.equal(parsed.command, 'npm');
    assert.deepEqual(parsed.args, ['run', 'test:all', '--', '--ci']);
  });
});

describe('natural language task parsing', () => {
  const projects: ProjectRecord[] = [
    { id: 'medilink', name: 'MediLink', path: '/p/medilink' },
    { id: 'austhir', name: 'AUSThir', path: '/p/austhir' },
    { id: 'resume', name: 'Resume', path: '/p/resume' },
  ];

  test('identifies the project from a plain sentence', () => {
    const parsed = parseNaturalTask('Fix the authentication bug in MediLink.', projects);
    assert.equal(parsed.projectId, 'medilink');
    assert.equal(parsed.matchedOn, 'MediLink');
  });

  test('is case and punctuation insensitive', () => {
    assert.equal(parseNaturalTask('fix austhir build error', projects).projectId, 'austhir');
    assert.equal(parseNaturalTask('medi-link is broken', projects).projectId, 'medilink');
  });

  test('returns nothing when no project is mentioned', () => {
    const parsed = parseNaturalTask('please fix the bug', projects);
    assert.equal(parsed.projectId, null);
    assert.deepEqual(parsed.candidates, []);
  });

  test('asks instead of guessing between equally-good matches', () => {
    const ambiguous: ProjectRecord[] = [
      { id: 'shopapi', name: 'shopapi', path: '/p/a' },
      { id: 'blogapi', name: 'blogapi', path: '/p/b' },
    ];
    const parsed = parseNaturalTask('fix shopapi and blogapi', ambiguous);
    assert.equal(parsed.projectId, null);
    assert.equal(parsed.candidates.length, 2);
  });

  test('splits explicit /task arguments', () => {
    assert.deepEqual(splitTaskCommand('medilink Fix the login bug'), {
      selector: 'medilink',
      prompt: 'Fix the login bug',
    });
    assert.deepEqual(splitTaskCommand('1 do the thing'), { selector: '1', prompt: 'do the thing' });
    assert.equal(splitTaskCommand('medilink'), null);
    assert.equal(splitTaskCommand('   '), null);
  });
});

describe('prompt construction', () => {
  const project: ProjectRecord = { id: 'demo', name: 'Demo', path: '/p/demo' };

  test('embeds the operating rules and the user request', () => {
    const prompt = buildTaskPrompt({
      userRequest: 'Fix the login bug',
      project,
      testCommand: 'npm test',
      buildCommand: 'npm run build',
      attempt: 0,
      failureContext: null,
      autoCommit: false,
    });
    assert.ok(prompt.includes('Fix the login bug'));
    assert.ok(prompt.includes('Never read, print, echo, or copy secrets'));
    assert.ok(prompt.includes('Do NOT create a git commit'));
    assert.ok(prompt.includes('npm test'));
    assert.ok(!prompt.includes('RECOVERY ATTEMPT'));
  });

  test('adds failure context on a recovery attempt', () => {
    const prompt = buildTaskPrompt({
      userRequest: 'Fix the login bug',
      project,
      testCommand: 'npm test',
      buildCommand: null,
      attempt: 1,
      failureContext: 'AssertionError: expected 200 got 401',
      autoCommit: false,
    });
    assert.ok(prompt.includes('RECOVERY ATTEMPT 1'));
    assert.ok(prompt.includes('expected 200 got 401'));
  });
});

describe('configuration', () => {
  function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
    const saved = { ...process.env };
    try {
      for (const [key, value] of Object.entries(vars)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      return fn();
    } finally {
      process.env = saved;
    }
  }

  const BASE = { TELEGRAM_BOT_TOKEN: '123:abc', AUTHORIZED_TELEGRAM_USER_ID: '4242' };

  test('refuses to start without a bot token', () => {
    withEnv({ ...BASE, TELEGRAM_BOT_TOKEN: undefined }, () => {
      assert.throws(() => loadConfig(), ConfigError);
    });
  });

  test('refuses to start without an authorized user', () => {
    withEnv({ ...BASE, AUTHORIZED_TELEGRAM_USER_ID: undefined }, () => {
      assert.throws(() => loadConfig(), ConfigError);
    });
  });

  test('rejects a non-numeric telegram id', () => {
    withEnv({ ...BASE, AUTHORIZED_TELEGRAM_USER_ID: 'not-a-number' }, () => {
      assert.throws(() => loadConfig(), ConfigError);
    });
  });

  test('defaults are safe: no auto-push, approvals on, checkpoints on', () => {
    withEnv({ ...BASE, AUTO_PUSH: undefined, AUTO_COMMIT: undefined }, () => {
      const config = loadConfig();
      assert.equal(config.git.autoPush, false, 'auto-push must default to off');
      assert.equal(config.git.checkpoint, true);
      assert.equal(config.git.requireApprovalWhenDirty, true);
      assert.equal(config.safety.requireApprovalForDangerousActions, true);
      assert.equal(config.limits.maxConcurrentTasks, 1);
    });
  });

  test('applies cost limits from the environment', () => {
    withEnv(
      { ...BASE, MAX_AI_CREDITS_PER_TASK: '3.5', MAX_AI_CREDITS_PER_DAY: '20', MAX_TASK_DURATION_MINUTES: '15' },
      () => {
        const config = loadConfig();
        assert.equal(config.limits.maxAiCreditsPerTask, 3.5);
        assert.equal(config.limits.maxAiCreditsPerDay, 20);
        assert.equal(config.limits.maxTaskDurationMs, 15 * 60_000);
      },
    );
  });

  test('rejects out-of-range and malformed limits', () => {
    withEnv({ ...BASE, MAX_TASK_DURATION_MINUTES: '0' }, () => assert.throws(() => loadConfig(), ConfigError));
    withEnv({ ...BASE, MAX_RETRIES: 'many' }, () => assert.throws(() => loadConfig(), ConfigError));
    withEnv({ ...BASE, COPILOT_EFFORT: 'turbo' }, () => assert.throws(() => loadConfig(), ConfigError));
  });

  test('allows running without telegram for offline tooling', () => {
    withEnv({ TELEGRAM_BOT_TOKEN: undefined, AUTHORIZED_TELEGRAM_USER_ID: undefined }, () => {
      const config = loadConfig({ requireTelegram: false });
      assert.deepEqual(config.telegram.authorizedUserIds, []);
    });
  });
});
