import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
-- Mailbox identities: spawned workers and hand-started sessions alike.
CREATE TABLE IF NOT EXISTS identities (
  identity TEXT PRIMARY KEY, family TEXT NOT NULL, model TEXT NOT NULL,
  session_id TEXT UNIQUE, repo TEXT, seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS status (identity TEXT PRIMARY KEY, text TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mail (
  id INTEGER PRIMARY KEY, recipient TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL,
  at TEXT NOT NULL, seen_at TEXT
);
CREATE INDEX IF NOT EXISTS mail_unseen ON mail (recipient, seen_at);
CREATE TABLE IF NOT EXISTS delegators (
  id TEXT PRIMARY KEY, cli TEXT, repo TEXT, max_agents INTEGER NOT NULL DEFAULT 3,
  handoff TEXT, handoff_at TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
-- A spawned worker. id is its mailbox identity.
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, delegator TEXT NOT NULL, vendor TEXT NOT NULL, model TEXT NOT NULL,
  slot TEXT, repo TEXT NOT NULL, base TEXT NOT NULL, branch TEXT NOT NULL, dir TEXT,
  brief TEXT NOT NULL, title TEXT NOT NULL, test_writer INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL, idle INTEGER NOT NULL DEFAULT 0, token TEXT NOT NULL UNIQUE,
  session_id TEXT, report TEXT, sha TEXT, pr_url TEXT, pr_number INTEGER, gate TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ci_note TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, delegator TEXT NOT NULL, agent TEXT, kind TEXT NOT NULL,
  text TEXT NOT NULL, at TEXT NOT NULL, consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS asks (
  id INTEGER PRIMARY KEY, agent TEXT NOT NULL, question TEXT NOT NULL, choices TEXT NOT NULL,
  answer TEXT, at TEXT NOT NULL, answered_at TEXT, nonce TEXT
);
CREATE TABLE IF NOT EXISTS tests (
  id TEXT PRIMARY KEY, agent TEXT, requester TEXT NOT NULL, repo TEXT NOT NULL, sha TEXT NOT NULL,
  branch TEXT, selector TEXT, gpu INTEGER NOT NULL DEFAULT 0, artifacts TEXT NOT NULL DEFAULT '[]',
  timeout_s INTEGER NOT NULL, round INTEGER NOT NULL, purpose TEXT NOT NULL DEFAULT 'agent',
  state TEXT NOT NULL, report TEXT, created_at TEXT NOT NULL, claimed_at TEXT, done_at TEXT
);
`;

/** Opens (and migrates) the store. Only the broker process calls this. */
export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Columns added after phase 1 shipped; ALTER fails harmlessly when they exist.
  for (const col of ["role TEXT NOT NULL DEFAULT 'impl'", 'depends_on TEXT', 'start_from TEXT']) {
    try { db.exec(`ALTER TABLE agents ADD COLUMN ${col}`); } catch {}
  }
  try { db.exec('ALTER TABLE asks ADD COLUMN nonce TEXT'); } catch {}
  return db;
}

export const kvGet = (db, key) => db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
export const kvDel = (db, key) => db.prepare('DELETE FROM kv WHERE key = ?').run(key);
export const kvSet = (db, key, value) => db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
