import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  advisorySessionBudget,
  classifyTask,
  escalate,
  remainingSessionBudget,
  shouldReview,
  touchesSecuritySurface,
  type TaskPlan,
} from '../src/orchestrator/plan.js';
import { assessConfidence, parseReview } from '../src/orchestrator/confidence.js';

const plan = (request: string, opts: { unverifiable?: boolean; max?: number } = {}): TaskPlan =>
  classifyTask({ request, unverifiable: opts.unverifiable ?? false, maxAgentCalls: opts.max ?? 4 });

describe('session budget slicing', () => {
  test('an advisory session can never spend the whole task budget', () => {
    // Observed live: a survey handed the full 15-credit cap burned all of it
    // and the implementer never ran. A quarter is the ceiling.
    assert.equal(advisorySessionBudget(15, 0), 3);
    assert.equal(advisorySessionBudget(10, 0), 2);
    assert.equal(advisorySessionBudget(4, 0), 1);
    assert.ok(advisorySessionBudget(15, 0) < 15);
  });

  test('an advisory session is also capped by what is left', () => {
    assert.ok(advisorySessionBudget(15, 14.5) <= 0.5);
  });

  test('a later session only gets the remainder, never the full cap again', () => {
    assert.equal(remainingSessionBudget(15, 10), 5);
    assert.ok(remainingSessionBudget(15, 14.99) > 0, 'a positive remainder stays enforceable');
  });

  test('an uncapped task stays uncapped in the executor\u2019s language (0)', () => {
    assert.equal(remainingSessionBudget(0, 5), 0);
    assert.equal(advisorySessionBudget(0, 5), 0);
  });
});

describe('orchestration: choosing how much AI to spend', () => {
  test('a trivial edit gets exactly one agent', () => {
    for (const request of [
      'Rename the function getUser to fetchUser',
      'Fix the typo in the README heading',
      'Bump the version number to 1.2.0',
    ]) {
      const p = plan(request);
      assert.equal(p.complexity, 'simple', request);
      assert.deepEqual(p.roles, ['implementer'], request);
      assert.equal(p.useExplorer, false, request);
      assert.equal(p.alwaysReview, false, request);
    }
  });

  test('an ordinary bug fix gets implementer plus verification, no survey', () => {
    const p = plan('Fix the API bug where /users returns 500 when the id is missing');
    assert.equal(p.complexity, 'medium');
    assert.deepEqual(p.roles, ['implementer']);
    assert.equal(p.useExplorer, false);
  });

  test('cross-cutting work gets a survey and a review', () => {
    const p = plan('Redesign authentication so sessions are stored server-side');
    assert.equal(p.complexity, 'complex');
    assert.equal(p.useExplorer, true);
    assert.equal(p.alwaysReview, true);
    assert.deepEqual(p.roles, ['explorer', 'implementer', 'security-reviewer']);
  });

  test('a compound request is treated as complex even without keywords', () => {
    const p = plan('Add a cache layer and update the docs and also change the CLI output and add metrics');
    assert.equal(p.complexity, 'complex');
  });

  test('security WORDS alone never buy an extra paid session', () => {
    // Regression: "login" in a cosmetic request once triggered a full security
    // review, doubling the cost of a text change.
    const p = plan('Fix the typo on the login page heading');
    assert.equal(p.alwaysReview, false, 'a typo must not pay for a security audit');
    assert.deepEqual(p.roles, ['implementer']);
    assert.equal(p.securitySubject, true, 'but the subject is still noted');
  });

  test('a project with nothing to run gets a review instead of tests', () => {
    const p = plan('Add a helper that formats durations', { unverifiable: true });
    assert.equal(p.alwaysReview, true);
    assert.ok(p.roles.includes('reviewer'));
    assert.match(p.reason, /no test or build command/);
  });

  test('the operator ceiling is never exceeded', () => {
    const p = plan('Redesign authentication and rewrite the session store', { max: 2 });
    assert.ok(p.agentBudget <= 2, `budget ${p.agentBudget} exceeded the ceiling`);
  });

  test('a plan too big for the ceiling is trimmed, not merely promised', () => {
    const p = plan('Redesign authentication and rewrite the session store', { max: 3 });
    assert.ok(p.roles.length <= p.agentBudget, 'every planned role must be affordable');
    assert.equal(p.useExplorer, false, 'the survey is dropped first');
    assert.ok(p.roles.includes('security-reviewer'), 'the quality gate is kept');
    assert.match(p.reason, /trimmed to fit/);
  });

  test('a review is only planned when the fix it may demand is also affordable', () => {
    // Paying to be told about a defect with no budget left to fix it is waste.
    const p = plan('Redesign authentication and rewrite the session store', { max: 2 });
    assert.deepEqual(p.roles, ['implementer']);
    assert.equal(p.alwaysReview, false);
  });

  test('a ceiling of one leaves just the implementer', () => {
    const p = plan('Redesign authentication across the whole system', { max: 1 });
    assert.deepEqual(p.roles, ['implementer']);
    assert.equal(p.alwaysReview, false, 'it must not claim a review it cannot run');
  });

  test('budget always leaves room for the roles it planned', () => {
    const p = plan('Redesign authentication so sessions are stored server-side');
    assert.ok(p.agentBudget >= p.roles.length, 'a plan must be affordable');
  });
});

describe('orchestration: evidence beats guessing', () => {
  test('security-relevant paths are recognised', () => {
    const hits = touchesSecuritySurface([
      'src/auth/session.ts',
      'src/ui/button.tsx',
      '.github/workflows/deploy.yml',
      'Dockerfile',
    ]);
    assert.deepEqual(hits.sort(), ['.github/workflows/deploy.yml', 'Dockerfile', 'src/auth/session.ts'].sort());
  });

  test('a small request that touches auth is escalated after the fact', () => {
    const before = plan('Update the user profile page');
    assert.equal(before.alwaysReview, false);

    const after = escalate(before, ['src/profile.ts', 'src/auth/middleware.ts']);
    assert.equal(after.alwaysReview, true, 'evidence must escalate the plan');
    assert.ok(after.roles.includes('security-reviewer'));
    assert.match(after.reason, /escalated because/);
    assert.ok(after.agentBudget >= after.roles.length);
  });

  test('escalation is idempotent and does not inflate the budget repeatedly', () => {
    const first = escalate(plan('Update the login form'), ['src/auth/x.ts']);
    const second = escalate(first, ['src/auth/x.ts']);
    assert.deepEqual(second.roles, first.roles);
    assert.equal(second.agentBudget, first.agentBudget);
  });

  test('an innocuous diff does not escalate', () => {
    const p = plan('Update the docs');
    assert.deepEqual(escalate(p, ['README.md', 'docs/guide.md']), p);
  });
});

describe('orchestration: self-evaluation', () => {
  const base = {
    testsRun: true,
    testsPassed: true,
    buildRun: true,
    buildPassed: true,
    retriesUsed: 0,
    changedFiles: ['src/a.ts'],
    linesChanged: 12,
    stopReason: 'completed',
    manifestsChanged: false,
  };

  test('a small verified change is trusted without paying for a review', () => {
    const c = assessConfidence(base);
    assert.ok(c.score >= 0.75, `expected high confidence, got ${c.score}`);
  });

  test('an unverified change is not trusted', () => {
    const c = assessConfidence({ ...base, testsRun: false, buildRun: false });
    assert.ok(c.score < 0.75, `expected low confidence, got ${c.score}`);
    assert.ok(c.factors.some((f) => /no tests/.test(f)));
  });

  test('confidence drops when the agent struggled', () => {
    const calm = assessConfidence(base).score;
    const struggled = assessConfidence({ ...base, retriesUsed: 2 }).score;
    assert.ok(struggled < calm, 'retries must reduce confidence');
  });

  test('an unfinished run is treated as suspect', () => {
    const c = assessConfidence({ ...base, stopReason: 'turn-limit' });
    assert.ok(c.score < 0.75);
    assert.ok(c.factors.some((f) => /unfinished/.test(f)));
  });

  test('touching security paths lowers confidence even when tests pass', () => {
    const ordinary = assessConfidence(base).score;
    const risky = assessConfidence({ ...base, changedFiles: ['src/auth/session.ts'] }).score;
    assert.ok(risky < ordinary);
  });

  test('the score stays inside 0..1 under pathological input', () => {
    const worst = assessConfidence({
      ...base,
      testsPassed: false,
      buildPassed: false,
      retriesUsed: 20,
      changedFiles: Array.from({ length: 90 }, (_, i) => `src/auth/f${i}.ts`),
      linesChanged: 90_000,
      stopReason: 'credit-limit',
      manifestsChanged: true,
    });
    assert.ok(worst.score >= 0 && worst.score <= 1, `score out of range: ${worst.score}`);
  });
});

describe('orchestration: is a review worth buying', () => {
  const budget = {
    enabled: true,
    changedFileCount: 3,
    reviewsDone: 0,
    confidence: 0.5,
    threshold: 0.75,
    agentCallsUsed: 1,
    attempt: 0,
    maxRetries: 2,
    creditsUsed: 1,
    maxCreditsPerTask: 10,
  };
  const complexPlan = plan('Redesign authentication across the whole system');

  test('low confidence buys a review', () => {
    assert.deepEqual(shouldReview(complexPlan, budget), { review: true });
  });

  test('high confidence on an ordinary change does not', () => {
    const simple = plan('Fix the API bug where /users returns 500');
    assert.deepEqual(shouldReview(simple, { ...budget, confidence: 0.9 }), {
      review: false,
      reason: 'not-needed',
    });
  });

  test('a plan that always reviews does so even at high confidence', () => {
    assert.deepEqual(shouldReview(complexPlan, { ...budget, confidence: 0.99 }), { review: true });
  });

  test('a change with no files is never reviewed', () => {
    assert.equal(shouldReview(complexPlan, { ...budget, changedFileCount: 0 }).review, false);
  });

  test('review runs at most once, so there is no review ping-pong', () => {
    assert.equal(shouldReview(complexPlan, { ...budget, reviewsDone: 1 }).review, false);
  });

  test('a review with no budget for the fix it may demand is refused', () => {
    // Being told about a defect with nothing left to fix it is wasted money.
    const decision = shouldReview(complexPlan, { ...budget, agentCallsUsed: complexPlan.agentBudget - 1 });
    assert.deepEqual(decision, { review: false, reason: 'unaffordable' });
  });

  test('no retries left means no review', () => {
    assert.deepEqual(shouldReview(complexPlan, { ...budget, attempt: 2, maxRetries: 2 }), {
      review: false,
      reason: 'unaffordable',
    });
  });

  test('an exhausted credit budget stops the spend', () => {
    assert.deepEqual(shouldReview(complexPlan, { ...budget, creditsUsed: 10, maxCreditsPerTask: 10 }), {
      review: false,
      reason: 'unaffordable',
    });
  });

  test('an unlimited credit budget does not block a review', () => {
    assert.equal(shouldReview(complexPlan, { ...budget, creditsUsed: 999, maxCreditsPerTask: 0 }).review, true);
  });

  test('orchestration switched off never reviews', () => {
    assert.equal(shouldReview(complexPlan, { ...budget, enabled: false }).review, false);
  });
});

describe('orchestration: reading a review', () => {
  test('a pass verdict is understood', () => {
    assert.equal(parseReview('Looks good.\n\nVERDICT: PASS').verdict, 'pass');
  });

  test('a rejection is understood and its findings extracted', () => {
    const r = parseReview(
      ['- src/a.ts: the null branch is unreachable', '- src/b.ts: leaks a file handle', 'VERDICT: CHANGES_REQUIRED'].join(
        '\n',
      ),
    );
    assert.equal(r.verdict, 'changes-required');
    assert.equal(r.findings.length, 2);
    assert.match(r.findings[0]!, /unreachable/);
  });

  test('a review with no verdict is never silently read as approval', () => {
    assert.equal(parseReview('I think this is probably fine, mostly.').verdict, 'unclear');
  });

  test('findings are capped so one runaway review cannot flood the next prompt', () => {
    const many = Array.from({ length: 50 }, (_, i) => `- finding number ${i}`).join('\n');
    assert.ok(parseReview(`${many}\nVERDICT: CHANGES_REQUIRED`).findings.length <= 12);
  });
});
