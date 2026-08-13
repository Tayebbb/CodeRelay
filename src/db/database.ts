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
];

/** Open (creating if needed) the agent database and run pending migrations. */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
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
