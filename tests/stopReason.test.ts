import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideAfterCopilot, UNREPORTED_USAGE_FAILURE, type StopDecisionInput } from '../src/runner/stopReason.js';
import type { CopilotRunResult } from '../src/copilot/executor.js';
import type { StopReason } from '../src/copilot/executor.js';

function result(overrides: Partial<CopilotRunResult> = {}): CopilotRunResult {
  return {
    exitCode: 0,
    stopReason: 'completed',
    sessionId: 's1',
    usage: {} as CopilotRunResult['usage'],
    aiCredits: 1,
    outputTokens: 100,
    filesModified: [],
    linesAdded: 0,
    linesRemoved: 0,
    usageReported: true,
    finalMessage: 'done',
    turns: 2,
    stderr: '',
    transcript: [],
    ...overrides,
  };
}

function decide(overrides: Partial<StopDecisionInput> = {}) {
  return decideAfterCopilot({
    result: result(),
    activeModel: 'claude-opus-5',
    availableModels: ['claude-opus-5', 'claude-sonnet-4.6'],
    configuredFallback: 'claude-opus-4.8',
    modelSwitchUsed: false,
    unreportedRuns: 0,
    tamper: null,
    checkpointRef: 'refs/remote-agent/checkpoint-1',
    ...overrides,
  });
}

describe('what to do after a Copilot session', () => {
  test('a clean run proceeds to verification', () => {
    assert.deepEqual(decide(), { kind: 'proceed' });
  });

  test('cancellation is reported as cancellation, not failure', () => {
    const action = decide({ result: result({ stopReason: 'cancelled', exitCode: null }) });
    assert.equal(action.kind, 'fail');
    assert.equal(action.kind === 'fail' && action.status, 'CANCELLED');
  });

  test('a timeout is reported as a timeout', () => {
    const action = decide({ result: result({ stopReason: 'timeout' }) });
    assert.equal(action.kind === 'fail' && action.status, 'TIMED_OUT');
  });

  test('tampering with git config outranks every other outcome', () => {
    // Even a perfectly successful run must not proceed if hooks changed: the
    // next git command would execute them.
    for (const stopReason of ['completed', 'timeout', 'quota-exhausted', 'auth-error'] as StopReason[]) {
      const action = decide({ result: result({ stopReason }), tamper: '.git/hooks/post-commit added' });
      assert.equal(action.kind, 'fail', stopReason);
      assert.match(action.kind === 'fail' ? action.message : '', /git hooks or git configuration/);
    }
  });

  test('the tamper message tells the operator how to get back', () => {
    const action = decide({ tamper: 'x', checkpointRef: 'refs/remote-agent/checkpoint-7' });
    assert.match(action.kind === 'fail' ? action.message : '', /git checkout refs\/remote-agent\/checkpoint-7 -- \./);
  });

  test('a refused model switches to the configured fallback', () => {
    const action = decide({ result: result({ stopReason: 'model-unavailable', exitCode: 1 }) });
    assert.deepEqual(action, { kind: 'switch-model', model: 'claude-opus-4.8', previous: 'claude-opus-5' });
  });

  test('when the fallback is the model that was refused, another is chosen', () => {
    const action = decide({
      result: result({ stopReason: 'model-unavailable', exitCode: 1 }),
      activeModel: 'claude-opus-4.8',
      configuredFallback: 'claude-opus-4.8',
      availableModels: ['claude-opus-4.8', 'claude-sonnet-4.6'],
    });
    assert.deepEqual(action, { kind: 'switch-model', model: 'claude-sonnet-4.6', previous: 'claude-opus-4.8' });
  });

  test('a second refused model is reported as an exhausted allowance, not a config error', () => {
    // Observed live: once the account allowance is spent, EVERY model in the
    // catalogue is refused with the same "not available" wording. Telling the
    // operator to change COPILOT_MODEL_FALLBACK would send them chasing the
    // wrong problem while thousands of kilometres from the machine.
    const action = decide({
      result: result({ stopReason: 'model-unavailable', exitCode: 1 }),
      modelSwitchUsed: true,
    });
    assert.equal(action.kind, 'fail');
    const message = action.kind === 'fail' ? action.message : '';
    assert.match(message, /allowance is exhausted/);
    assert.match(message, /no configuration change is needed/);
  });

  test('with no alternative model to try at all, the config advice is given', () => {
    const action = decide({
      result: result({ stopReason: 'model-unavailable', exitCode: 1 }),
      configuredFallback: null,
      availableModels: ['claude-opus-5'],
    });
    assert.equal(action.kind, 'fail');
    assert.match(action.kind === 'fail' ? action.message : '', /COPILOT_MODEL_FALLBACK/);
  });

  test('quota exhaustion stops without enabling paid usage', () => {
    const action = decide({ result: result({ stopReason: 'quota-exhausted', exitCode: 1 }) });
    assert.equal(action.kind, 'fail');
    assert.match(action.kind === 'fail' ? action.message : '', /No additional paid usage was enabled/);
  });

  test('an auth failure names the fix and is not a billing message', () => {
    const action = decide({ result: result({ stopReason: 'auth-error', exitCode: 1 }) });
    assert.match(action.kind === 'fail' ? action.message : '', /copilot login/);
    assert.doesNotMatch(action.kind === 'fail' ? action.message : '', /credit budget/);
  });

  test('the per-task credit limit halts the loop but keeps the work', () => {
    const action = decide({ result: result({ stopReason: 'credit-limit' }) });
    assert.equal(action.kind, 'halt');
  });

  test('a failed spawn is fatal, not retried', () => {
    assert.equal(decide({ result: result({ stopReason: 'spawn-error', exitCode: null }) }).kind, 'fail');
  });

  test('a run that reported no cost is flagged, and fatal the second time', () => {
    const first = decide({ result: result({ usageReported: false }), unreportedRuns: 0 });
    assert.deepEqual(first, { kind: 'unreported-usage', fatal: false });

    const second = decide({ result: result({ usageReported: false }), unreportedRuns: 1 });
    assert.deepEqual(second, { kind: 'unreported-usage', fatal: true });
    assert.match(UNREPORTED_USAGE_FAILURE, /credit budget cannot be enforced/);
  });

  test('a run with no turns is not treated as unreported usage', () => {
    // Nothing happened, so there is nothing to account for.
    assert.deepEqual(decide({ result: result({ usageReported: false, turns: 0 }) }), { kind: 'proceed' });
  });

  test('a non-zero exit becomes a retry carrying the reason', () => {
    const action = decide({ result: result({ exitCode: 3, stderr: 'boom' }) });
    assert.equal(action.kind, 'retry');
    assert.match(action.kind === 'retry' ? action.failureContext : '', /exited with code 3/);
    assert.match(action.kind === 'retry' ? action.failureContext : '', /boom/);
  });

  test('an authentication failure is never reported as an accounting problem', () => {
    // Regression: the usage guard used to run before failure classification, so
    // an expired login was reported as "the credit budget cannot be enforced".
    const action = decide({
      result: result({ stopReason: 'auth-error', exitCode: 1, usageReported: false, turns: 1 }),
    });
    assert.equal(action.kind, 'fail');
    assert.match(action.kind === 'fail' ? action.message : '', /authenticate/);
  });

  test('every stop reason is handled without falling through by accident', () => {
    const reasons: StopReason[] = [
      'completed',
      'timeout',
      'cancelled',
      'turn-limit',
      'credit-limit',
      'spawn-error',
      'startup-error',
      'auth-error',
      'model-unavailable',
      'quota-exhausted',
    ];
    for (const stopReason of reasons) {
      const action = decide({ result: result({ stopReason, exitCode: stopReason === 'completed' ? 0 : 1 }) });
      assert.ok(
        ['proceed', 'retry', 'switch-model', 'halt', 'fail', 'unreported-usage'].includes(action.kind),
        `${stopReason} produced ${action.kind}`,
      );
    }
  });
});
