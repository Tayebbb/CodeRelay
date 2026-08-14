import { spawn } from 'node:child_process';
import { redact } from '../core/redact.js';
import { killProcessTree } from './processTree.js';
import { cmdExeInvocation, UnsafeCommandError } from './winCommand.js';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  /**
   * Environment for the child. When provided it REPLACES the parent environment
   * rather than extending it — anything running project-supplied code must not
   * inherit the operator's credentials.
   */
  env?: NodeJS.ProcessEnv;
  /** Only for commands assembled by this app, never for Telegram input. */
  shell?: boolean;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** Written to the child's stdin, then closed. */
  stdin?: string;
}

/** Grace period after a kill before we stop waiting for `close` and resolve anyway. */
const POST_KILL_GRACE_MS = 10_000;

/**
 * Run a command with an argument array. `shell` defaults to false so that
 * untrusted text can never be interpreted by a shell.
 *
 * Termination is guaranteed: on timeout or abort the whole process tree is
 * killed, and a watchdog resolves the promise even if a surviving grandchild
 * keeps the stdio pipes open — otherwise a hung test command would occupy the
 * single task slot forever.
 */
export function execCommand(command: string, args: string[], options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const maxBytes = options.maxOutputBytes ?? 200_000;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let watchdog: NodeJS.Timeout | null = null;

    // On Windows package-manager entry points are `.cmd` shims that Node will not
    // spawn without a shell. Rather than let Node build an unquoted command line,
    // we invoke cmd.exe ourselves with every token quoted.
    let file = command;
    let spawnArgs = args;
    let useShell = options.shell ?? false;
    let verbatim = false;
    if (useShell && process.platform === 'win32') {
      try {
        const invocation = cmdExeInvocation(command, args);
        file = invocation.file;
        spawnArgs = invocation.args;
        useShell = false;
        verbatim = true;
      } catch (err) {
        if (err instanceof UnsafeCommandError) {
          resolve({
            code: null,
            stdout: '',
            stderr: redact(err.message),
            timedOut: false,
            durationMs: 0,
          });
          return;
        }
        throw err;
      }
    }

    const child = spawn(file, spawnArgs, {
      cwd: options.cwd,
      // NoDefaultCurrentDirectoryInExePath is not cosmetic: without it cmd.exe
      // resolves a bare program name from the CURRENT DIRECTORY before PATH, so
      // a repository shipping its own npm.cmd / mvn.cmd / gradle.bat gets
      // executed as the user by the verification step alone. Verified on
      // Windows 10: `npm --version` in such a directory ran the planted file.
      env: {
        ...(options.env ?? process.env),
        NO_COLOR: '1',
        NoDefaultCurrentDirectoryInExePath: '1',
      },
      shell: useShell,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      stdio: options.stdin === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    });

    const done = (code: number | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (watchdog) clearTimeout(watchdog);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        stdout: redact(stdout),
        stderr: redact(stderr + extra),
        timedOut,
        durationMs: Date.now() - started,
      });
    };

    const terminate = (reason: string) => {
      killProcessTree(child);
      if (watchdog) return;
      watchdog = setTimeout(
        () => done(null, `\n[remote-agent] ${reason}; process tree killed but did not report exit.`),
        POST_KILL_GRACE_MS,
      );
      watchdog.unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate('command timed out');
    }, options.timeoutMs ?? 120_000);

    const onAbort = () => terminate('command aborted');
    // An ALREADY-aborted signal never dispatches another 'abort' event, so a
    // cancellation that landed just before the spawn must be handled directly.
    if (options.signal?.aborted) terminate('command aborted before start');
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    if (options.stdin !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(options.stdin);
    }

    child.stdout?.setEncoding('utf8');
    // A killed child (taskkill /F /T) can emit EPIPE/ECONNRESET on its pipes.
    // An EventEmitter with no 'error' listener THROWS, which would take the
    // whole agent down on the recovery path — exactly when things are already
    // going wrong — and orphan the Copilot process that is still spending.
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    child.stdout?.on('data', (d: string) => {
      stdout = (stdout + d).slice(-maxBytes);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      stderr = (stderr + d).slice(-maxBytes);
    });

    child.on('error', (err) => done(null, '\n' + String(err)));
    child.on('close', (code) => done(code));
  });
}

/** Last `count` non-empty lines — used to build compact failure summaries. */
export function tailLines(text: string, count: number): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(-count)
    .join('\n');
}
