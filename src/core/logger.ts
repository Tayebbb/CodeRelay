import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { redact, redactDeep } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  taskId?: number;
  [key: string]: unknown;
}

let minLevel: LogLevel = 'info';
let logFile: string | null = null;

export function configureLogger(options: { level?: LogLevel; directory?: string }): void {
  if (options.level) minLevel = options.level;
  if (options.directory) {
    mkdirSync(options.directory, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    logFile = path.join(options.directory, `agent-${day}.log`);
  }
}

/** Current structured log file path, if file logging is configured. */
export function currentLogFile(): string | null {
  return logFile;
}

function write(record: LogRecord): void {
  if (LEVEL_ORDER[record.level] < LEVEL_ORDER[minLevel]) return;

  const safe = redactDeep(record);
  const line = JSON.stringify(safe);

  const consoleMsg = `${safe.ts} ${safe.level.toUpperCase().padEnd(5)} [${safe.scope}] ${safe.msg}`;
  if (record.level === 'error') console.error(consoleMsg);
  else if (record.level === 'warn') console.warn(consoleMsg);
  else console.log(consoleMsg);

  if (logFile) {
    try {
      appendFileSync(logFile, line + '\n', 'utf8');
    } catch {
      // Logging must never take the agent down.
    }
  }
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(scope: string, meta?: Record<string, unknown>): Logger;
}

export function createLogger(scope: string, base: Record<string, unknown> = {}): Logger {
  const emit = (level: LogLevel, msg: string, meta?: Record<string, unknown>) =>
    write({ ts: new Date().toISOString(), level, scope, msg: redact(msg), ...base, ...meta });

  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    child: (childScope, meta) => createLogger(`${scope}:${childScope}`, { ...base, ...meta }),
  };
}

/** Convert an unknown throwable into a redacted, human-readable message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return redact(err.message);
  return redact(String(err));
}
