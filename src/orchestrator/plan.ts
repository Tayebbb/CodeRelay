/**
 * Deciding how much AI to spend must itself cost no AI.
 *
 * In this system one "agent" is one Copilot CLI session, and one session costs
 * real credits. The CLI already explores, edits and runs tools inside a single
 * session, so a literal seven-agent pipeline would multiply the bill by seven
 * for the same change. Everything in this file is therefore plain TypeScript:
 * classification, budgeting and escalation are decided from the request text
 * and from evidence the repository gives us for free.
 *
 * Roles are prompt profiles plus a tool policy, not separate processes:
 *   - explorer and reviewer run READ-ONLY (writes denied at the CLI level)
 *   - implementer is the only role allowed to modify the working tree
 */

export type Role = 'explorer' | 'implementer' | 'reviewer' | 'security-reviewer';

export type Complexity = 'simple' | 'medium' | 'complex';

export interface TaskPlan {
  complexity: Complexity;
  /** Roles the orchestrator intends to use, in order. */
  roles: Role[];
  /** Read-only survey pass before any edit. */
  useExplorer: boolean;
  /** Review after verification passes, even when confidence is high. */
  alwaysReview: boolean;
  /** The request is about security, so any review that runs takes that angle. */
  securitySubject: boolean;
  /** Upper bound on paid sessions for this task, including retries. */
  agentBudget: number;
  /** Human-readable justification, shown to the operator and logged. */
  reason: string;
}

/**
 * Work that is mechanical and locally verifiable. These are matched as whole
 * words against the request; a request that also trips a complex signal is not
 * treated as simple.
 */
const SIMPLE_SIGNALS = [
  /\brename\b/i,
  /\btypo\b/i,
  /\bspelling\b/i,
  /\bcomment\b/i,
  /\bformat(ting)?\b/i,
  /\blint\b/i,
  /\bbump\b/i,
  /\bversion number\b/i,
  /\bchange the (text|string|label|message|colou?r)\b/i,
  /\badd a (log|console\.log|print) statement\b/i,
];

/** Work that reaches across modules or changes a contract. */
const COMPLEX_SIGNALS = [
  /\bredesign\b/i,
  /\bre-?architect\b/i,
  /\brewrite\b/i,
  /\bmigrat(e|ion)\b/i,
  /\brefactor\b/i,
  /\bacross (the )?(codebase|project|app|system)\b/i,
  /\bdata ?(base)? schema\b/i,
  /\bbreaking change\b/i,
  /\bconcurren(t|cy)\b/i,
  /\brace condition\b/i,
  /\bperformance\b/i,
  /\bmemory leak\b/i,
  /\bapi contract\b/i,
  /\bmulti[- ]?step\b/i,
];

/**
 * Subject matter where a mistake is expensive and not always caught by tests.
 * Matching this forces a security review regardless of the size of the diff.
 */
const SECURITY_SIGNALS = [
  /\bauth(entication|orisation|orization)?\b/i,
  /\blogin\b/i,
  /\bpassword\b/i,
  /\bcredential\b/i,
  /\btoken\b/i,
  /\bsession\b/i,
  /\bcookie\b/i,
  /\bcrypto|encrypt|decrypt|hash(ing)?\b/i,
  /\bpermission|privilege|access control\b/i,
  /\bsql\b/i,
  /\binjection\b/i,
  /\bsanitis|sanitiz|escap(e|ing)\b/i,
  /\bcors\b/i,
  /\bcsrf|xss\b/i,
  /\bsecret\b/i,
  /\bcertificate|tls|ssl\b/i,
];

/** Paths whose contents are security-relevant no matter what the request said. */
const SECURITY_PATHS = [
  /(^|\/)auth/i,
  /(^|\/)login/i,
  /(^|\/)session/i,
  /(^|\/)security/i,
  /(^|\/)permission/i,
  /(^|\/)crypto/i,
  /(^|\/)middleware/i,
  /(^|\/)\.github\/workflows\//i,
  /dockerfile/i,
  /(^|\/)nginx|apache/i,
];

export function touchesSecuritySurface(files: string[]): string[] {
  return files.filter((f) => SECURITY_PATHS.some((re) => re.test(f)));
}

export interface ReviewBudget {
  enabled: boolean;
  changedFileCount: number;
  reviewsDone: number;
  confidence: number;
  threshold: number;
  agentCallsUsed: number;
  attempt: number;
  maxRetries: number;
  creditsUsed: number;
  maxCreditsPerTask: number;
}

export type ReviewDecision =
  | { review: true }
  | { review: false; reason: 'not-needed' | 'unaffordable' };

/**
 * Whether a paid review is both warranted and affordable.
 *
 * Separated from the runner because this is the spend decision: getting it
 * wrong either wastes credits on trivial changes or ships unreviewed risky
 * ones. A review costs TWO sessions — itself and the fix it may demand — so
 * being told about a defect with no budget left to act on it is pure waste.
 */
export function shouldReview(plan: TaskPlan, budget: ReviewBudget): ReviewDecision {
  const wanted =
    budget.enabled &&
    budget.changedFileCount > 0 &&
    budget.reviewsDone < 1 &&
    (plan.alwaysReview || budget.confidence < budget.threshold);
  if (!wanted) return { review: false, reason: 'not-needed' };

  const affordable =
    budget.agentCallsUsed + 2 <= plan.agentBudget &&
    budget.attempt < budget.maxRetries &&
    (budget.maxCreditsPerTask <= 0 || budget.creditsUsed < budget.maxCreditsPerTask);
  return affordable ? { review: true } : { review: false, reason: 'unaffordable' };
}

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((n, re) => (re.test(text) ? n + 1 : n), 0);
}

export interface ClassifyInput {
  request: string;
  /** True when the project has no test or build command we can run. */
  unverifiable: boolean;
  /** Operator ceiling; the plan never exceeds it. */
  maxAgentCalls: number;
}

/**
 * Classify the request and choose the cheapest pipeline that can still be
 * trusted. Deliberately conservative in one direction only: when a request is
 * ambiguous we prefer the cheaper plan and let *evidence* escalate it later
 * (see `escalate`), because escalation is driven by facts and guessing is not.
 */
export function classifyTask(input: ClassifyInput): TaskPlan {
  const text = input.request;
  const words = text.trim().split(/\s+/).length;

  const complexHits = countMatches(text, COMPLEX_SIGNALS);
  const simpleHits = countMatches(text, SIMPLE_SIGNALS);
  const securityHits = countMatches(text, SECURITY_SIGNALS);

  // A long request is usually a compound request.
  const longRequest = words > 60;
  const manyRequirements = (text.match(/\b(and|then|also|additionally)\b/gi) ?? []).length >= 3;

  let complexity: Complexity;
  let reason: string;

  if (complexHits > 0 || longRequest || manyRequirements) {
    complexity = 'complex';
    reason = complexHits > 0 ? 'the request describes cross-cutting work' : 'the request has several parts';
  } else if (simpleHits > 0 && securityHits === 0 && words <= 25) {
    complexity = 'simple';
    reason = 'the request is a small, local, mechanical edit';
  } else {
    complexity = 'medium';
    reason = 'a single focused change';
  }

  // Security subject matter is never "simple", whatever else it looks like.
  if (securityHits > 0 && complexity === 'simple') {
    complexity = 'medium';
    reason = 'security-relevant subject matter';
  }

  const roles: Role[] = ['implementer'];
  const useExplorer = complexity === 'complex';
  if (useExplorer) roles.unshift('explorer');

  // Review when the work is genuinely broad, or when nothing else can check it.
  //
  // Security KEYWORDS deliberately do not buy a review on their own: "fix the
  // typo on the login page" would pay for a security audit of a text change.
  // What does buy one is evidence — see `escalate`, which reacts to the files
  // the change actually touched, and costs nothing to evaluate.
  const alwaysReview = complexity === 'complex' || input.unverifiable;
  if (alwaysReview) roles.push(securityHits > 0 ? 'security-reviewer' : 'reviewer');

  if (input.unverifiable && complexity !== 'complex') {
    reason += '; no test or build command exists, so a review replaces them';
  }

  // Budget = the planned sessions plus headroom for one fix pass. Simple work
  // gets no headroom for extra agents at all: it gets retries, which are cheaper
  // than a second opinion and usually sufficient.
  const planned = roles.length;
  const headroom = complexity === 'simple' ? 1 : 2;
  const agentBudget = Math.max(1, Math.min(input.maxAgentCalls, planned + headroom));

  // A plan must be affordable, or it is a lie. When the operator's ceiling is
  // lower than the plan, drop roles rather than promise them: the survey goes
  // first because it only saves effort, whereas the review catches defects.
  //
  // A review costs two sessions, not one: there is no point paying to be told
  // about a defect if there is no budget left to fix it.
  const cost = (rs: Role[]): number => rs.length + (rs.some((r) => r.endsWith('reviewer')) ? 1 : 0);
  let affordable = roles;
  if (cost(affordable) > agentBudget) affordable = affordable.filter((r) => r !== 'explorer');
  if (cost(affordable) > agentBudget) affordable = ['implementer'];
  const trimmed = affordable.length < roles.length;

  return {
    complexity,
    roles: affordable,
    useExplorer: affordable.includes('explorer'),
    alwaysReview: alwaysReview && affordable.some((r) => r.endsWith('reviewer')),
    securitySubject: securityHits > 0,
    agentBudget,
    reason: trimmed ? `${reason}; trimmed to fit MAX_AGENT_CALLS_PER_TASK=${input.maxAgentCalls}` : reason,
  };
}

/**
 * Evidence-based escalation, applied after the change exists.
 *
 * This is where the design earns its keep: instead of guessing up front that a
 * task is dangerous, we look at what was actually touched. A one-line request
 * that turns out to have rewritten the auth middleware gets reviewed.
 */
export function escalate(plan: TaskPlan, changedFiles: string[]): TaskPlan {
  const risky = touchesSecuritySurface(changedFiles);
  if (risky.length === 0) return plan;
  if (plan.roles.includes('security-reviewer')) return plan;

  const roles = plan.roles.filter((r) => r !== 'reviewer');
  roles.push('security-reviewer');
  return {
    ...plan,
    roles,
    alwaysReview: true,
    agentBudget: Math.max(plan.agentBudget, roles.length + 1),
    reason: `${plan.reason}; escalated because it changed ${risky.slice(0, 3).join(', ')}`,
  };
}
