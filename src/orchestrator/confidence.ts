/**
 * "How confident am I that this change is correct?"
 *
 * Answered from evidence rather than by asking a model to grade itself. A model
 * asked to score its own work costs a session and tends to say "high", so the
 * signals here are all things we already know for free by the time the change
 * exists: did the tests run, did they pass, how big is the diff, how many
 * recovery attempts were needed, did the agent stop cleanly.
 *
 * Confidence decides one thing only: whether a paid review session is worth it.
 */

import { touchesSecuritySurface } from './plan.js';

export interface ConfidenceInput {
  /** Verification the supervisor actually executed. */
  testsRun: boolean;
  testsPassed: boolean;
  buildRun: boolean;
  buildPassed: boolean;
  /** Recovery attempts consumed before success. */
  retriesUsed: number;
  changedFiles: string[];
  linesChanged: number;
  /** Copilot's own stop reason for the successful attempt. */
  stopReason: string;
  /** The agent edited files that define what the build/test step runs. */
  manifestsChanged: boolean;
}

export interface ConfidenceResult {
  /** 0..1, where 1 is "verified by everything available". */
  score: number;
  /** Short phrases explaining the score, for the operator and the log. */
  factors: string[];
}

/**
 * Start from "no evidence" and add credit for verification that actually ran.
 * The largest single term is passing tests, because it is the only signal that
 * observes real behaviour.
 */
export function assessConfidence(input: ConfidenceInput): ConfidenceResult {
  const factors: string[] = [];
  let score = 0.3; // an unverified change by a capable agent

  if (input.testsRun && input.testsPassed) {
    score += 0.4;
    factors.push('tests passed');
  } else if (input.testsRun && !input.testsPassed) {
    score -= 0.3;
    factors.push('tests failed');
  } else {
    score -= 0.1;
    factors.push('no tests were run');
  }

  if (input.buildRun && input.buildPassed) {
    score += 0.15;
    factors.push('build passed');
  } else if (input.buildRun && !input.buildPassed) {
    score -= 0.2;
    factors.push('build failed');
  }

  if (input.retriesUsed > 0) {
    score -= 0.1 * input.retriesUsed;
    factors.push(`${input.retriesUsed} recovery attempt(s) needed`);
  }

  // A large diff is not wrong, but it is harder to be sure about.
  if (input.changedFiles.length > 15 || input.linesChanged > 600) {
    score -= 0.15;
    factors.push('large diff');
  } else if (input.changedFiles.length <= 2 && input.linesChanged <= 40) {
    score += 0.1;
    factors.push('small, contained diff');
  }

  const risky = touchesSecuritySurface(input.changedFiles);
  if (risky.length > 0) {
    score -= 0.2;
    factors.push(`touches security-relevant paths (${risky.slice(0, 2).join(', ')})`);
  }

  if (input.manifestsChanged) {
    score -= 0.1;
    factors.push('build/test definition changed');
  }

  // Both of these mean the same thing: the agent was cut off before it decided
  // it was done, so the change may be half-applied.
  if (input.stopReason === 'turn-limit') {
    score -= 0.25;
    factors.push('agent hit its turn limit — work may be unfinished');
  } else if (input.stopReason === 'credit-limit') {
    score -= 0.25;
    factors.push('agent stopped on its credit budget — work may be unfinished');
  }

  return { score: Math.max(0, Math.min(1, score)), factors };
}

export type ReviewVerdict = 'pass' | 'changes-required' | 'unclear';

export interface ReviewOutcome {
  verdict: ReviewVerdict;
  findings: string[];
}

/**
 * Parse a reviewer session's closing report.
 *
 * The reviewer is asked to end with a single VERDICT line. Parsing is
 * deliberately strict-then-forgiving: an unparseable review is reported as
 * `unclear` and treated as a soft failure by the caller rather than being
 * silently read as approval.
 */
export function parseReview(text: string): ReviewOutcome {
  const findings = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, ''))
    .filter((l) => l.length > 3)
    .slice(0, 12);

  const verdictLine = /VERDICT\s*[:=]\s*([A-Z_\- ]+)/i.exec(text);
  if (verdictLine) {
    const raw = verdictLine[1]!.trim().toUpperCase().replace(/[\s_]+/g, '-');
    if (raw.startsWith('PASS') || raw.startsWith('OK') || raw.startsWith('APPROVE')) {
      return { verdict: 'pass', findings };
    }
    if (raw.startsWith('CHANGES') || raw.startsWith('FAIL') || raw.startsWith('REJECT')) {
      return { verdict: 'changes-required', findings };
    }
  }
  return { verdict: 'unclear', findings };
}
