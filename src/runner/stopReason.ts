/**
 * What to do after a Copilot session ends.
 *
 * This is the money-and-safety decision: whether to fail, retry, switch model,
 * or carry on to verification. It is a pure function so the whole matrix can be
 * tested exhaustively without starting a process — the branching used to live
 * inline in a several-hundred-line method, where a duplicated case survived
 * review precisely because nobody could see the whole chain at once.
 */

import type { CopilotRunResult } from '../copilot/executor.js';
import { tailLines } from '../util/exec.js';

export type StopAction =
  /** The run is usable; go on to verification. */
  | { kind: 'proceed' }
  /** The run failed in a way another attempt might fix. */
  | { kind: 'retry'; failureContext: string }
  /** The API refused the model; try a different one without burning an attempt. */
  | { kind: 'switch-model'; model: string; previous: string }
  /** Stop the loop but keep whatever was produced. */
  | { kind: 'halt'; message: string }
  /** The run reported no cost; the caller must record it before continuing. */
  | { kind: 'unreported-usage'; fatal: boolean }
  | { kind: 'fail'; message: string; status: 'FAILED' | 'CANCELLED' | 'TIMED_OUT' };

export interface StopDecisionInput {
  result: CopilotRunResult;
  activeModel: string;
  /** Models the installed CLI advertises, used to find an alternative. */
  availableModels: string[];
  configuredFallback: string | null;
  /** True once a runtime model switch has already been spent. */
  modelSwitchUsed: boolean;
  /** Consecutive runs so far that reported no usage, before this one. */
  unreportedRuns: number;
  /** Non-null when git hooks or config changed during the run. */
  tamper: string | null;
  checkpointRef: string | undefined;
}

const fail = (message: string, status: 'FAILED' | 'CANCELLED' | 'TIMED_OUT' = 'FAILED'): StopAction => ({
  kind: 'fail',
  message,
  status,
});

/** Order matters: the most specific and most alarming causes are reported first. */
export function decideAfterCopilot(input: StopDecisionInput): StopAction {
  const { result, activeModel } = input;

  if (result.stopReason === 'cancelled') return fail('Cancelled by operator.', 'CANCELLED');

  // Checked before anything else looks at the repository: a run that exits
  // non-zero can still have written a hook or a config knob, and the next git
  // command would execute it.
  if (input.tamper) {
    return fail(
      'Stopped: the agent modified git hooks or git configuration.\n\n' +
        input.tamper +
        '\n\nThose files execute commands as you. Nothing was tested, committed, or pushed.\n' +
        `Inspect them, then restore with: git checkout ${input.checkpointRef ?? 'HEAD'} -- .`,
    );
  }

  if (result.stopReason === 'timeout') {
    return fail('Copilot exceeded the task time limit and was stopped.', 'TIMED_OUT');
  }

  if (result.stopReason === 'model-unavailable') {
    // Prefer the configured fallback; if that is already what just got refused,
    // take any other model the CLI advertises.
    const next =
      input.configuredFallback && input.configuredFallback !== activeModel
        ? input.configuredFallback
        : (input.availableModels.find((m) => m !== activeModel) ?? null);
    if (!input.modelSwitchUsed && next) {
      return { kind: 'switch-model', model: next, previous: activeModel };
    }
    // A SECOND model refused means this is not about the model. Observed on a
    // real account: once the Copilot allowance is spent every model in the
    // catalogue is refused with the same "not available" wording, so advising a
    // config change here would send the operator chasing the wrong problem.
    if (input.modelSwitchUsed) {
      return fail(
        '🛑 Copilot refused every model that was tried, which almost always means your\n' +
          'Copilot allowance is exhausted right now rather than anything being misconfigured.\n\n' +
          'Nothing was changed. Check your usage at github.com/settings/copilot and retry later\n' +
          'with /retry — no configuration change is needed if this worked earlier today.\n\n' +
          tailLines(result.stderr, 4),
      );
    }
    return fail(
      `Copilot refused the model "${activeModel}" and no alternative model is available to try.\n\n` +
        'Set COPILOT_MODEL_FALLBACK in .env to a model you can still use, then /retry.\n\n' +
        tailLines(result.stderr, 6),
    );
  }

  if (result.stopReason === 'quota-exhausted') {
    return fail(
      '🛑 Copilot reported that your included usage is exhausted or rate limited.\n\n' +
        'The task was stopped. No additional paid usage was enabled.\n' +
        (result.stderr ? `\nDetail: ${tailLines(result.stderr, 4)}` : ''),
    );
  }

  if (result.stopReason === 'credit-limit') {
    return { kind: 'halt', message: '🛑 AI-credit budget for this task reached; stopping.' };
  }

  if (result.stopReason === 'spawn-error') {
    return fail(`Could not start Copilot CLI: ${tailLines(result.stderr, 5)}`);
  }

  if (result.stopReason === 'auth-error') {
    return fail(
      '🔑 Copilot could not authenticate, so the task was stopped.\n\n' +
        'Sign in again on the PC with:  copilot login\n' +
        'Then re-send this task with /retry.\n' +
        (result.stderr ? `\nDetail: ${tailLines(result.stderr, 4)}` : ''),
    );
  }

  if (result.stopReason === 'startup-error') {
    return fail(
      'Copilot CLI failed before it began working (bad model, agent, or authentication).\n\n' +
        tailLines(result.stderr, 8),
    );
  }

  // A run that never told us what it cost must not be treated as free, or the
  // budget guards would silently stop working after a CLI output change. Checked
  // after the reasons above so a genuine auth or quota failure is reported as
  // itself rather than as an accounting problem.
  if (!result.usageReported && result.turns > 0) {
    return { kind: 'unreported-usage', fatal: input.unreportedRuns + 1 >= 2 };
  }

  if (result.exitCode !== 0) {
    return {
      kind: 'retry',
      failureContext: `Copilot exited with code ${result.exitCode}. ${tailLines(result.stderr, 10)}`,
    };
  }

  return { kind: 'proceed' };
}

export const UNREPORTED_USAGE_FAILURE =
  'Copilot did not report AI usage for two consecutive runs, so the credit budget cannot be enforced.\n' +
  'Stopping instead of continuing to spend. Run `remote-agent doctor` — the CLI output format may have changed.';
