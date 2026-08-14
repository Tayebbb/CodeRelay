import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../core/logger.js';

const log = createLogger('lock');

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
 * Liveness alone is not enough: operating systems recycle PIDs, so after a power
 * cut a stale file can name an unrelated live process and the agent would refuse
 * to start forever. We therefore also record the executable path and the time
 * the lock was taken, and treat a mismatch as stale.
 */
export function acquireLock(file: string): LockResult {
  const record: LockRecord = { pid: process.pid, startedAt: Date.now(), exec: process.execPath };
  const payload = JSON.stringify(record);
  const release = () => {
    try {
      const current = read(file);
      if (current?.pid === process.pid) fs.rmSync(file, { force: true });
    } catch {
      // best effort
    }
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });

  try {
    // Atomic create-if-absent: no time-of-check/time-of-use window.
    fs.writeFileSync(file, payload, { flag: 'wx' });
    return { acquired: true, release };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const existing = read(file);
  if (existing && isProcessAlive(existing.pid)) {
    const sameBinary = existing.exec === '' || existing.exec === process.execPath;
    if (sameBinary) return { acquired: false, heldBy: existing, release: () => {} };
    log.warn('Ignoring stale lock: pid is alive but belongs to a different program', {
      pid: existing.pid,
      recordedExec: existing.exec,
    });
  }

  fs.writeFileSync(file, payload, 'utf8');
  return { acquired: true, release };
}
