import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Kill a process AND its descendants.
 *
 * This matters more than it looks: with `shell: true` on Windows the direct
 * child is `cmd.exe`, and killing only that leaves `npm`/`node`/test-runner
 * grandchildren alive holding the stdio pipes — so `close` never fires and the
 * awaiting promise hangs forever, permanently occupying the single task slot.
 */
export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      // spawn reports failure asynchronously; without this listener a missing
      // taskkill.exe would surface as an unhandled 'error' event.
      killer.on('error', () => forceKill(child));
      return;
    } catch {
      // fall through
    }
  }
  forceKill(child);
}

function forceKill(child: ChildProcess): void {
  try {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    }, 5_000).unref();
  } catch {
    // already gone
  }
}
