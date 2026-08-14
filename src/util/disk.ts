import fs from 'node:fs';

export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
  freeRatio: number;
  /** False when the platform or Node build could not report it. */
  known: boolean;
}

/** Below this the agent refuses to start a task. */
export const MIN_FREE_BYTES = 512 * 1024 * 1024;

/**
 * Free space where the agent is about to work.
 *
 * A full disk is one of the nastiest failure modes for this system: git cannot
 * write the checkpoint, SQLite cannot record state, and the agent's own edits
 * truncate — all at once, and all silently. Checking first turns that into a
 * clean refusal.
 */
export function diskSpace(target: string): DiskSpace {
  const unknown: DiskSpace = { freeBytes: 0, totalBytes: 0, freeRatio: 1, known: false };
  const statfs = (fs as unknown as { statfsSync?: (p: string) => { bsize: number; blocks: number; bavail: number } })
    .statfsSync;
  if (typeof statfs !== 'function') return unknown;

  try {
    const stats = statfs(target);
    const freeBytes = stats.bsize * stats.bavail;
    const totalBytes = stats.bsize * stats.blocks;
    return {
      freeBytes,
      totalBytes,
      freeRatio: totalBytes > 0 ? freeBytes / totalBytes : 1,
      known: true,
    };
  } catch {
    return unknown;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** Human-readable reason to refuse, or null when there is enough room. */
export function insufficientDiskSpace(target: string, minFreeBytes = MIN_FREE_BYTES): string | null {
  const space = diskSpace(target);
  if (!space.known || space.freeBytes >= minFreeBytes) return null;
  return `only ${formatBytes(space.freeBytes)} free (need at least ${formatBytes(minFreeBytes)})`;
}
