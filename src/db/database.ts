import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type Db = DatabaseSync;

const MIGRATIONS: Array<{ id: number; sql: string }> = [
  {
    id: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS tasks (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id           INTEGER NOT NULL,
        chat_id           INTEGER NOT NULL,
        project_id        TEXT    NOT NULL,
        prompt            TEXT    NOT NULL,
        status            TEXT    NOT NULL,
        created_at        INTEGER NOT NULL,
        started_at        INTEGER,
        completed_at      INTEGER,
        result_json       TEXT,
        error             TEXT,
        commit_hash       TEXT,
        branch            TEXT,
        retry_count       INTEGER NOT NULL DEFAULT 0,
        approval_required INTEGER NOT NULL DEFAULT 0,
        approval_status   TEXT    NOT NULL DEFAULT 'NONE',
        approval_reason   TEXT,
        usage_json        TEXT    NOT NULL DEFAULT '{}',
        runner_pid        INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);

      CREATE TABLE IF NOT EXISTS task_events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id  INTEGER NOT NULL,
        ts       INTEGER NOT NULL,
        kind     TEXT    NOT NULL,
        message  TEXT    NOT NULL,
        meta     TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, id);

      CREATE TABLE IF NOT EXISTS usage_ledger (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id  INTEGER,
        ts       INTEGER NOT NULL,
        credits  REAL    NOT NULL,
        model    TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_ledger(ts);

      CREATE TABLE IF NOT EXISTS processed_updates (
        update_id INTEGER PRIMARY KEY,
        ts        INTEGER NOT NULL
      );
    `,
  },
  {
    id: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS outbox (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id  INTEGER NOT NULL,
        body     TEXT    NOT NULL,
        ts       INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_ts ON outbox(ts);
    `,
  },
  {
    id: 3,
    sql: `
      ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'telegram';
      ALTER TABLE tasks ADD COLUMN model TEXT;
    `,
  },
  {
    id: 4,
    sql: `
      ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(status, priority DESC, id ASC);
    `,
  },
];

export class DatabaseCorruptError extends Error {}

/** Open (creating if needed) the agent database and run pending migrations. */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);

  // SQLite opens lazily, so a corrupt file would otherwise appear to open fine
  // and then fail on the first real query — mid-task, unattended.
  try {
    db.exec('SELECT count(*) FROM sqlite_master;');
  } catch (err) {
    try {
      db.close();
    } catch {
      // nothing more to do
    }
    throw new DatabaseCorruptError(`Database at ${file} is not readable: ${(err as Error).message}`);
  }

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  // Power-safe rather than merely crash-safe: this database is tiny and the
  // whole point is surviving an unexpected shutdown.
  db.exec('PRAGMA synchronous = FULL;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);');

  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: number }>).map((r) => r.id),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(migration.id, Date.now());
  }

  return db;
}

/**
 * Open the database, quarantining it if it is unreadable.
 *
 * For an unattended service, refusing to start forever is worse than losing
 * task history: the operator would just see a bot that never comes back.
 */
export function openDatabaseResilient(file: string): { db: Db; quarantined: string | null } {
  try {
    return { db: openDatabase(file), quarantined: null };
  } catch (err) {
    if (!(err instanceof DatabaseCorruptError) || file === ':memory:') throw err;

    const aside = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, aside);
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.rmSync(`${file}${suffix}`, { force: true });
      } catch {
        // best effort
      }
    }
    return { db: openDatabase(file), quarantined: aside };
  }
}
