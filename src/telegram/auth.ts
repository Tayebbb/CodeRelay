/** Authorization for the Telegram surface. Single-user by design. */

export interface AuthDecision {
  allowed: boolean;
  reason: 'ok' | 'no-user' | 'not-authorized';
}

export function authorize(userId: number | undefined, authorizedIds: readonly number[]): AuthDecision {
  if (userId === undefined || Number.isNaN(userId)) {
    return { allowed: false, reason: 'no-user' };
  }
  // An empty allow-list means "nobody" — never "everybody".
  if (authorizedIds.length === 0) {
    return { allowed: false, reason: 'not-authorized' };
  }
  return authorizedIds.includes(userId)
    ? { allowed: true, reason: 'ok' }
    : { allowed: false, reason: 'not-authorized' };
}

/**
 * Throttles how often we react to unknown users at all, so an attacker cannot
 * use the bot as an amplifier or infer anything from response timing/volume.
 */
export class UnauthorizedThrottle {
  private seen = new Map<number, number>();

  constructor(private readonly windowMs = 60 * 60 * 1000) {}

  /** True when this stranger should get the single generic reply. */
  shouldRespond(userId: number): boolean {
    const now = Date.now();
    const last = this.seen.get(userId);
    if (last !== undefined && now - last < this.windowMs) return false;
    this.seen.set(userId, now);
    if (this.seen.size > 1000) this.seen.clear();
    return true;
  }
}
