import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPermissionPolicy, DEFAULT_DENIED_COMMANDS } from '../src/copilot/permissions.js';
import { buildCopilotArgs } from '../src/copilot/executor.js';
import { JsonlStream, parseJsonlLine } from '../src/copilot/events.js';
import { parseModels, parseVersion, selectModel } from '../src/copilot/detect.js';

const POLICY = buildPermissionPolicy({
  allowedUrls: ['github.com'],
  extraDeniedCommands: ['mycompany-deploy'],
  extraDirs: [],
});

describe('copilot permission policy', () => {
  test('never grants blanket permissions', () => {
    const forbidden = ['--yolo', '--allow-all', '--allow-all-paths', '--allow-all-urls'];
    for (const flag of forbidden) {
      assert.ok(!POLICY.args.includes(flag), `${flag} must never be passed`);
    }
  });

  test('enables tools only in combination with a deny-list', () => {
    assert.ok(POLICY.args.includes('--allow-all-tools'));
    assert.ok(POLICY.args.some((a) => a.startsWith('--deny-tool=')));
  });

  test('denies destructive and privilege-escalating commands', () => {
    for (const command of ['rm', 'del', 'format', 'sudo', 'runas', 'shutdown', 'netsh', 'reg']) {
      assert.ok(POLICY.args.includes(`--deny-tool=shell(${command})`), `${command} must be denied`);
    }
  });

  test('denies credential and remote-access tooling', () => {
    for (const command of ['ssh', 'scp', 'cmdkey', 'security', 'gpg', 'gh']) {
      assert.ok(POLICY.args.includes(`--deny-tool=shell(${command})`), `${command} must be denied`);
    }
  });

  test('denies destructive git operations including push', () => {
    for (const command of ['git push', 'git reset', 'git clean', 'git filter-branch']) {
      assert.ok(POLICY.args.includes(`--deny-tool=shell(${command})`), `${command} must be denied`);
    }
  });

  test('honours extra denied commands from configuration', () => {
    assert.ok(POLICY.args.includes('--deny-tool=shell(mycompany-deploy)'));
    assert.ok(POLICY.deniedCommands.length > DEFAULT_DENIED_COMMANDS.length);
  });

  test('allows only the configured URLs', () => {
    assert.ok(POLICY.args.includes('--allow-url=github.com'));
    assert.equal(POLICY.args.filter((a) => a.startsWith('--allow-url=')).length, 1);
  });

  test('adds extra directories explicitly rather than opening all paths', () => {
    const withDirs = buildPermissionPolicy({
      allowedUrls: [],
      extraDeniedCommands: [],
      extraDirs: ['/srv/shared-lib'],
    });
    assert.ok(withDirs.args.includes('--add-dir'));
    assert.ok(withDirs.args.includes('/srv/shared-lib'));
    assert.ok(!withDirs.args.includes('--allow-all-paths'));
  });
});

describe('copilot argument construction', () => {
  const base = {
    launcher: { command: 'node', baseArgs: [], description: 'node', safe: true },
    cwd: '/tmp/project',
    prompt: 'Fix the bug',
    model: 'claude-opus-4.8',
    effort: 'high' as string | null,
    agent: 'remote-engineer' as string | null,
    autopilot: true,
    maxAutopilotContinues: 5,
    permissionArgs: POLICY.args,
    timeoutMs: 60_000,
    maxTurns: 40,
    creditBudget: 10,
  };

  test('runs non-interactively with JSON output', () => {
    const args = buildCopilotArgs(base);
    assert.ok(args.includes('-p'));
    assert.equal(args[args.indexOf('-p') + 1], 'Fix the bug');
    assert.ok(args.includes('--output-format'));
    assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  });

  test('passes the selected model and effort through', () => {
    const args = buildCopilotArgs(base);
    assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-4.8');
    assert.equal(args[args.indexOf('--effort') + 1], 'high');
    assert.equal(args[args.indexOf('--agent') + 1], 'remote-engineer');
  });

  test('bounds autopilot continuations', () => {
    const args = buildCopilotArgs(base);
    assert.equal(args[args.indexOf('--mode') + 1], 'autopilot');
    assert.equal(args[args.indexOf('--max-autopilot-continues') + 1], '5');
  });

  test('never waits for a human and never exposes the session remotely', () => {
    const args = buildCopilotArgs(base);
    assert.ok(args.includes('--no-ask-user'));
    assert.ok(args.includes('--no-remote'));
    assert.ok(args.includes('--no-auto-update'));
  });

  test('keeps prompt text as a single argv element (no shell interpolation)', () => {
    const args = buildCopilotArgs({ ...base, prompt: 'fix "it"; rm -rf / && echo $(whoami)' });
    assert.equal(args[args.indexOf('-p') + 1], 'fix "it"; rm -rf / && echo $(whoami)');
  });

  test('marks configured environment variables as secret', () => {
    const args = buildCopilotArgs({ ...base, secretEnvVars: ['TELEGRAM_BOT_TOKEN'] });
    assert.ok(args.includes('--secret-env-vars=TELEGRAM_BOT_TOKEN'));
  });

  test('omits autopilot flags when disabled', () => {
    const args = buildCopilotArgs({ ...base, autopilot: false });
    assert.ok(!args.includes('--mode'));
  });
});

describe('JSONL event parsing', () => {
  test('parses a result envelope with usage', () => {
    const line =
      '{"type":"result","timestamp":"2026-08-13T18:17:28.943Z","sessionId":"61ae865e","exitCode":0,"usage":{"premiumRequests":0.33,"codeChanges":{"linesAdded":2,"linesRemoved":1,"filesModified":["a.ts"]}}}';
    const event = parseJsonlLine(line);
    assert.equal(event?.type, 'result');
    assert.equal(event?.usage?.premiumRequests, 0.33);
    assert.deepEqual(event?.usage?.codeChanges?.filesModified, ['a.ts']);
  });

  test('ignores non-JSON noise', () => {
    assert.equal(parseJsonlLine('Run `copilot update` to check for updates.'), null);
    assert.equal(parseJsonlLine('{ not json'), null);
    assert.equal(parseJsonlLine(''), null);
  });

  test('reassembles events split across chunk boundaries', () => {
    const stream = new JsonlStream();
    assert.equal(stream.push('{"type":"assistant.turn').length, 0);
    const events = stream.push('_start","data":{"turnId":"0"}}\n');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'assistant.turn_start');
  });

  test('handles several events in one chunk', () => {
    const stream = new JsonlStream();
    const events = stream.push('{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n');
    assert.deepEqual(events.map((e) => e.type), ['a', 'b', 'c']);
  });
});

describe('model discovery and selection', () => {
  const HELP = `
  \`model\`: AI model to use for Copilot CLI; can be changed with /model command.
    - "claude-sonnet-4.6"
    - "claude-opus-4.8"
    - "gpt-5.5"

  \`contextTier\`: context window tier
`;

  test('parses the model catalogue from CLI help', () => {
    assert.deepEqual(parseModels(HELP), ['claude-sonnet-4.6', 'claude-opus-4.8', 'gpt-5.5']);
  });

  test('parses the CLI version', () => {
    assert.equal(parseVersion('GitHub Copilot CLI 1.0.63.'), '1.0.63');
    assert.equal(parseVersion('no version here'), null);
  });

  test('uses the requested model when the CLI offers it', () => {
    const selection = selectModel('claude-opus-4.8', 'claude-sonnet-4.6', parseModels(HELP));
    assert.equal(selection.model, 'claude-opus-4.8');
    assert.equal(selection.fellBack, false);
    assert.equal(selection.note, null);
  });

  test('falls back and explains when the model does not exist', () => {
    const selection = selectModel('claude-opus-5', 'claude-sonnet-4.6', parseModels(HELP));
    assert.equal(selection.model, 'claude-sonnet-4.6');
    assert.equal(selection.fellBack, true);
    assert.ok(selection.note?.includes('claude-opus-5'));
    assert.ok(selection.note?.includes('claude-opus-4.8'), 'the note lists what IS available');
  });

  test('never silently invents a model when no fallback is usable', () => {
    const selection = selectModel('claude-opus-5', null, parseModels(HELP));
    assert.equal(selection.available, false);
    assert.equal(selection.fellBack, false);
    assert.ok(selection.note);
  });

  test('passes through unchecked only when the catalogue is unknown', () => {
    const selection = selectModel('anything', null, []);
    assert.equal(selection.available, true);
    assert.ok(selection.note?.includes('unchecked'));
  });
});
