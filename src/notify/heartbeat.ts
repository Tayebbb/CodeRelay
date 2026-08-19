/**
 * Daily "still alive" message. The operator learns more from the ABSENCE of
 * this message than from its content: if the morning ping does not arrive,
 * the agent (or the PC) is down. Zero AI credits — one Telegram API call.
 */

export function msUntilNextLocalHour(hour: number, now: Date = new Date()): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export interface HeartbeatStats {
  completed: number;
  failed: number;
}

export function formatHeartbeat(uptimeMs: number, stats: HeartbeatStats): string {
  const hours = Math.round(uptimeMs / 360_000) / 10;
  const work =
    stats.completed === 0 && stats.failed === 0
      ? 'no tasks in the last 24h'
      : `last 24h: ${stats.completed} completed, ${stats.failed} failed/cancelled`;
  return `🟢 Daily heartbeat — agent online, uptime ${hours}h, ${work}.`;
}
