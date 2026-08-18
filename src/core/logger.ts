import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
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
let logDirectory: string | null = null;
let currentDay: string | null = null;
let activeFile: string | null = null;
let bytesWritten = 0;

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_LOG_AGE_DAYS = 30;

export function configureLogger(options: { level?: LogLevel; directory?: string }): void {
  if (options.level) minLevel = options.level;
  if (options.directory) {
    try {
      mkdirSync(options.directory, { recursive: true });
      logDirectory = options.directory;
    } catch (err) {
      // Availability over audit trail: an unusable log directory must not keep
      // the agent (and both interfaces) from starting.
      logDirectory = null;
      console.error(`Log directory unusable (${String(err)}); continuing with console logging only`);
    }
    currentDay = null;
    activeFile = null;
    pruneOldLogs();
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Resolve the file to write to now. The day is recomputed per write: an agent
 * that runs for a month would otherwise append everything to the file named
 * after the day it started.
 */
function resolveLogFile(): string | null {
  if (!logDirectory) return null;
  const day = today();
  if (day !== currentDay || activeFile === null) {
    currentDay = day;
    activeFile = path.join(logDirectory, `agent-${day}.log`);
    try {
      bytesWritten = statSync(activeFile).size;
    } catch {
      bytesWritten = 0;
    }
    pruneOldLogs();
  }
  return activeFile;
}

/** Rotate only when the running byte count says we must — no stat per line. */
function rotateIfLarge(file: string): void {
  if (bytesWritten < MAX_LOG_BYTES) return;
  try {
    renameSync(file, `${file}.${Date.now()}.old`);
  } catch {
    // Missing file or a race: nothing to rotate.
  }
  bytesWritten = 0;
}

function pruneOldLogs(): void {
  if (!logDirectory) return;
  const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const name of readdirSync(logDirectory)) {
      if (!name.startsWith('agent-')) continue;
      const full = path.join(logDirectory, name);
      if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true });
    }
  } catch {
    // Retention is best-effort.
  }
}

function write(record: LogRecord): void {
  if (LEVEL_ORDER[record.level] < LEVEL_ORDER[minLevel]) return;

  const safe = redactDeep(record);
  const line = JSON.stringify(safe);

  const consoleMsg = `${safe.ts} ${safe.level.toUpperCase().padEnd(5)} [${safe.scope}] ${safe.msg}`;
  if (record.level === 'error') console.error(consoleMsg);
  else if (record.level === 'warn') console.warn(consoleMsg);
  else console.log(consoleMsg);

  const file = resolveLogFile();
  if (file) {
    try {
      rotateIfLarge(file);
      const payload = line + '\n';
      appendFileSync(file, payload, 'utf8');
      bytesWritten += Buffer.byteLength(payload);
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
