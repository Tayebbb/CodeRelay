import { spawn } from 'node:child_process';
import { redact } from '../core/redact.js';

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
  env?: NodeJS.ProcessEnv;
  /** Only for commands assembled by this app, never for Telegram input. */
  shell?: boolean;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

/**
 * Run a command with an argument array. `shell` defaults to false so that
 * untrusted text can never be interpreted by a shell.
 */
export function execCommand(command: string, args: string[], options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const maxBytes = options.maxOutputBytes ?? 200_000;
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: '1', ...options.env },
      shell: options.shell ?? false,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, options.timeoutMs ?? 120_000);

    const onAbort = () => child.kill('SIGTERM');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      stdout = (stdout + d).slice(-maxBytes);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      stderr = (stderr + d).slice(-maxBytes);
    });

    const done = (code: number | null, extra = '') => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        stdout: redact(stdout),
        stderr: redact(stderr + extra),
        timedOut,
        durationMs: Date.now() - started,
      });
    };

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
