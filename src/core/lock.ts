import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../core/logger.js';

const log = createLogger('lock');

/** How often a live owner touches the lock file. Generous relative to
 * STALE_AFTER_MS (5× margin) to keep idle disk writes rare. */
const HEARTBEAT_MS = 120_000;
/** A lock this quiet within one boot has no live owner behind it. */
const STALE_AFTER_MS = 10 * 60_000;
/** Guards the boot-time comparison against wall-clock adjustments. */
const BOOT_MARGIN_MS = 5 * 60_000;

export interface LockRecord {
  pid: number;
  startedAt: number;
  exec: string;
}

export interface LockResult {
  acquired: boolean;
  heldBy?: LockRecord;
  release: () => void;
}

/** Test seams; production callers pass nothing. */
export interface LockOptions {
  nowMs?: () => number;
  uptimeMs?: () => number;
  heartbeatMs?: number;
  staleAfterMs?: number;
  bootMarginMs?: number;
}

function read(file: string): LockRecord | null {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return null;
    // Tolerate the legacy bare-pid format.
    if (/^\d+$/.test(raw)) return { pid: Number.parseInt(raw, 10), startedAt: 0, exec: '' };
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof parsed.pid !== 'number') return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt ?? 0, exec: parsed.exec ?? '' };
  } catch {
    return null;
  }
}

function mtimeMs(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Single-instance lock.
 *
 * PID liveness alone is not enough: operating systems recycle PIDs, so after a
 * crash or a reboot a stale file can name an unrelated live process — even
 * another node.exe, which defeats an executable-path comparison — and the
 * agent would refuse to start forever (a confirmed real-world lockout). Three
 * staleness signals are therefore combined:
 *
 *   1. dead pid, or pid owned by a different executable — stale;
 *   2. lock last touched before the current OS boot — no process survived
 *      the reboot, so it cannot have a live owner;
 *   3. lock silent for far longer than the heartbeat interval — a live owner
 *      touches the file every two minutes; a recycled pid does not.
 */
export function acquireLock(file: string, options: LockOptions = {}): LockResult {
  const now = options.nowMs ?? Date.now;
  const uptimeMs = options.uptimeMs ?? (() => os.uptime() * 1000);
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  const bootMarginMs = options.bootMarginMs ?? BOOT_MARGIN_MS;

  const record: LockRecord = { pid: process.pid, startedAt: now(), exec: process.execPath };
  const payload = JSON.stringify(record);

  let heartbeat: NodeJS.Timeout | null = null;
  const release = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    try {
      const current = read(file);
      if (current?.pid === process.pid) fs.rmSync(file, { force: true });
    } catch {
      // best effort
    }
  };
  const acquired = (): LockResult => {
    // The mtime is the liveness signal a future starter reads; unref'd so the
    // heartbeat never holds the process open on its own.
    heartbeat = setInterval(() => {
      try {
        const t = new Date(now());
        fs.utimesSync(file, t, t);
      } catch {
        // File removed underneath us: nothing to keep fresh.
      }
    }, heartbeatMs);
    heartbeat.unref?.();
    return { acquired: true, release };
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });

  try {
    // Atomic create-if-absent: no time-of-check/time-of-use window.
    fs.writeFileSync(file, payload, { flag: 'wx' });
    return acquired();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const existing = read(file);
  if (existing && isProcessAlive(existing.pid)) {
    const sameBinary = existing.exec === '' || existing.exec === process.execPath;
    if (sameBinary) {
      const touched = mtimeMs(file);
      if (touched !== null) {
        const bootTime = now() - uptimeMs();
        const preBoot = touched < bootTime - bootMarginMs;
        const silent = now() - touched > staleAfterMs;
        if (!preBoot && !silent) return { acquired: false, heldBy: existing, release: () => {} };
        log.warn('Ignoring stale lock: its pid is alive but the lock has not been touched by a live owner', {
          pid: existing.pid,
          lastTouched: new Date(touched).toISOString(),
          preBoot,
        });
      }
    } else {
      log.warn('Ignoring stale lock: pid is alive but belongs to a different program', {
        pid: existing.pid,
        recordedExec: existing.exec,
      });
    }
  }

  // Steal atomically: two racing starters must not both conclude they won.
  try {
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, payload, { flag: 'wx' });
    return acquired();
  } catch {
    const winner = read(file) ?? existing;
    return { acquired: false, heldBy: winner ?? undefined, release: () => {} };
  }
}
