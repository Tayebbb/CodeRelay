/**
 * The provider layer's job is to let a second CLI drive the same safety
 * machinery WITHOUT quietly lowering the bar. These tests exist because the
 * failure mode is silent: a provider that cannot express "deny shell(curl)"
 * still runs, still reports success, and voids a protection the README
 * promises. So the gate is asserted here, not trusted.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDER_IDS,
  claudeProvider,
  copilotProvider,
  isProviderId,
  missingCapabilities,
  selectProvider,
  type AgentProvider,
  type BuildArgsInput,
} from '../src/providers/index.js';
import { DEFAULT_DENIED_COMMANDS } from '../src/copilot/permissions.js';

function input(overrides: Partial<BuildArgsInput> = {}): BuildArgsInput {
  return {
    prompt: 'fix the failing test',
    model: 'test-model',
    extraDeniedCommands: [],
    readOnly: false,
    allowedUrls: [],
    extraDirs: [],
    allowRepoInstructions: false,
    allowRepoMcp: false,
    sandbox: false,
    budget: 50,
    secretEnvVars: ['TELEGRAM_BOT_TOKEN'],
    agent: null,
    effort: null,
    autopilot: true,
    maxAutopilotContinues: 10,
    ...overrides,
  };
}

describe('provider selection fails closed', () => {
  test('an unknown provider is rejected rather than defaulted', () => {
    assert.throws(() => selectProvider('cursor'), /Unknown agent provider/);
    assert.throws(() => selectProvider(''), /Unknown agent provider/);
  });

  test('every registered provider satisfies the mandatory capabilities', () => {
    for (const id of PROVIDER_IDS) {
      assert.deepEqual(missingCapabilities(selectProvider(id)), [], id);
    }
  });

  test('a provider that cannot deny shell commands is refused', () => {
    const weak = {
      ...copilotProvider,
      id: 'copilot' as const,
      capabilities: { ...copilotProvider.capabilities, denyShellCommands: false },
    } satisfies AgentProvider;

    const gaps = missingCapabilities(weak);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.capability, 'denyShellCommands');
    // The operator must be told what is lost, not merely that something failed.
    assert.match(gaps[0]!.consequence, /interpreters|network/i);
  });

  test('a provider that cannot ignore repository instructions is refused', () => {
    const weak = {
      ...copilotProvider,
      capabilities: { ...copilotProvider.capabilities, ignoreRepoInstructions: false },
    } satisfies AgentProvider;
    assert.equal(missingCapabilities(weak)[0]?.capability, 'ignoreRepoInstructions');
  });

  test('isProviderId does not accept prototype keys', () => {
    assert.equal(isProviderId('toString'), false);
    assert.equal(isProviderId('constructor'), false);
  });
});

describe('copilot provider stays behaviour-identical', () => {
  test('builds the same hardened argv as before', () => {
    const args = copilotProvider.buildArgs(input());

    assert.equal(args[0], '-p');
    assert.equal(args[1], 'fix the failing test');
    assert.ok(args.includes('--no-custom-instructions'));
    assert.ok(args.includes('--disable-builtin-mcps'));
    assert.ok(args.includes('--no-ask-user'));
    assert.ok(args.includes('--deny-tool=shell(curl)'));
    assert.ok(args.includes('--secret-env-vars=TELEGRAM_BOT_TOKEN'));
  });

  test('read-only roles are denied writes at the tool level', () => {
    assert.ok(copilotProvider.buildArgs(input({ readOnly: true })).includes('--deny-tool=write'));
    assert.ok(!copilotProvider.buildArgs(input()).includes('--deny-tool=write'));
  });

  test('a follow-up resumes the parent session by explicit id, and only then', () => {
    assert.ok(copilotProvider.capabilities.resumeSessions);
    const resumed = copilotProvider.buildArgs(input({ resumeSessionId: 'sess-42' }));
    assert.ok(resumed.includes('--resume=sess-42'));
    const cold = copilotProvider.buildArgs(input());
    assert.ok(!cold.some((a) => a.startsWith('--resume')), 'a cold task must never resume anything');
  });

  test('never passes a blanket-permission flag', () => {
    for (const flag of ['--yolo', '--allow-all', '--allow-all-paths', '--allow-all-urls']) {
      assert.ok(!copilotProvider.buildArgs(input({ readOnly: true })).includes(flag), flag);
    }
  });
});

describe('claude provider', () => {
  test('declares that it cannot resume sessions, and never emits a resume flag', () => {
    assert.equal(claudeProvider.capabilities.resumeSessions, false);
    const args = claudeProvider.buildArgs(input({ resumeSessionId: 'sess-42' }));
    assert.ok(!args.some((a) => a.includes('--resume') || a.includes('sess-42')));
    assert.ok(args.includes('--no-session-persistence'));
  });

  test('runs headless with a machine-readable stream', () => {
    const args = claudeProvider.buildArgs(input());
    assert.equal(args[0], '-p');
    assert.equal(args[1], 'fix the failing test');
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('stream-json'));
  });

  test('refuses repository-supplied instructions and MCP servers', () => {
    const args = claudeProvider.buildArgs(input());
    // --bare skips CLAUDE.md auto-discovery, hooks and plugin sync.
    assert.ok(args.includes('--bare'));
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(!claudeProvider.buildArgs(input({ allowRepoInstructions: true })).includes('--bare'));
  });

  test('never bypasses permissions', () => {
    const args = claudeProvider.buildArgs(input());
    assert.ok(!args.includes('--dangerously-skip-permissions'));
    assert.ok(!args.includes('bypassPermissions'));
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
  });

  test('shares the Copilot deny-list so the two cannot drift apart', () => {
    const denied = claudeProvider.buildArgs(input())[
      claudeProvider.buildArgs(input()).indexOf('--disallowedTools') + 1
    ]!;
    for (const command of DEFAULT_DENIED_COMMANDS) {
      assert.ok(denied.includes(`Bash(${command}:*)`), `${command} must be denied`);
    }
  });

  test('denies the network tools that no URL allow-list can cover', () => {
    const args = claudeProvider.buildArgs(input());
    const denied = args[args.indexOf('--disallowedTools') + 1]!;
    assert.ok(denied.includes('WebFetch'));
    assert.ok(denied.includes('WebSearch'));
  });

  test('read-only roles cannot write', () => {
    const args = claudeProvider.buildArgs(input({ readOnly: true }));
    const denied = args[args.indexOf('--disallowedTools') + 1]!;
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      assert.ok(denied.includes(tool), tool);
    }
  });

  test('does not leave session state in the target repository', () => {
    assert.ok(claudeProvider.buildArgs(input()).includes('--no-session-persistence'));
  });

  test('passes a spend ceiling to the CLI', () => {
    const args = claudeProvider.buildArgs(input({ budget: 2 }));
    assert.equal(args[args.indexOf('--max-budget-usd') + 1], '2.00');
  });

  test('reads cost from the stream-json result event', () => {
    const [event] = claudeProvider.parseLine(
      JSON.stringify({ type: 'result', result: 'done', total_cost_usd: 0.42, session_id: 's1', is_error: false }),
    );
    assert.equal(event?.kind, 'usage');
    assert.equal(event?.usage?.credits, 0.42);
    assert.equal(event?.terminal, true);
  });

  test('a result without a cost is not reported as free', () => {
    const [event] = claudeProvider.parseLine(JSON.stringify({ type: 'result', result: 'done' }));
    // Terminal, but with no figure: the runner treats this as unreported usage
    // and refuses to record the run as costing nothing.
    assert.equal(event?.terminal, true);
    assert.equal(event?.usage?.credits, undefined);
  });

  test('surfaces tool use for progress reporting', () => {
    const events = claudeProvider.parseLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
    );
    assert.ok(events.some((e) => e.kind === 'tool' && e.text === 'Bash'));
  });

  test('counts a turn per assistant message so the turn ceiling binds', () => {
    const events = claudeProvider.parseLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
    );
    assert.ok(events.some((e) => e.kind === 'turn-start'));
  });

  test('malformed output never throws', () => {
    for (const line of ['', 'not json', '{', 'null', '[]', '{"type":123}', '{"message":null}']) {
      assert.doesNotThrow(() => claudeProvider.parseLine(line));
    }
  });

  test('declares its gaps honestly rather than claiming parity', () => {
    // Claude Code cannot allow-list URLs by domain; saying otherwise would be
    // a false promise in the capability report.
    assert.equal(claudeProvider.capabilities.allowUrlsByDomain, false);
    assert.equal(copilotProvider.capabilities.allowUrlsByDomain, true);
  });

  test('states that it is billed separately from Copilot', () => {
    assert.match(claudeProvider.billing, /Anthropic/i);
    assert.match(copilotProvider.billing, /no additional cost/i);
  });
});
