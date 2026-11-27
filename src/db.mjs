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
-- Old ids of renamed agents (PRD "Token economy" stage 3): they resolve to the new one.
CREATE TABLE IF NOT EXISTS aliases (old TEXT PRIMARY KEY, new TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS status (identity TEXT PRIMARY KEY, text TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mail (
  id INTEGER PRIMARY KEY, recipient TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL,
  at TEXT NOT NULL, seen_at TEXT
);
CREATE INDEX IF NOT EXISTS mail_unseen ON mail (recipient, seen_at);
CREATE TABLE IF NOT EXISTS delegators (
  id TEXT PRIMARY KEY, cli TEXT, repo TEXT, max_agents INTEGER NOT NULL DEFAULT 3,
  handoff TEXT, handoff_at TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  gate INTEGER NOT NULL DEFAULT 1, automerge INTEGER NOT NULL DEFAULT 1
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
-- Rate-limit windows per slot account and vendor (phase 4b); latest reading only.
CREATE TABLE IF NOT EXISTS slot_usage (
  slot TEXT NOT NULL, vendor TEXT NOT NULL, window TEXT NOT NULL, used_pct REAL NOT NULL,
  resets_at TEXT, at TEXT NOT NULL, PRIMARY KEY (slot, vendor, window)
);
-- The host CLI's own windows (a delegator's status line or ~/.codex log; token economy); latest reading only.
-- Kept apart from slot_usage: the host may be signed in to another account than the slots.
CREATE TABLE IF NOT EXISTS host_usage (
  vendor TEXT NOT NULL, window TEXT NOT NULL, used_pct REAL NOT NULL, resets_at TEXT, at TEXT NOT NULL,
  PRIMARY KEY (vendor, window)
);
-- Several hosts (PRD "Several hosts"): satellites joined to this hub. key_hash: SHA-256 of the satellite key.
-- last_seq: highest event id taken from it (replays at or below it are skipped). capabilities: JSON.
CREATE TABLE IF NOT EXISTS hosts (
  name TEXT PRIMARY KEY, key_hash TEXT UNIQUE, created_at TEXT NOT NULL, last_seen INTEGER,
  online INTEGER NOT NULL DEFAULT 0, offline_since INTEGER, lost_at INTEGER, capabilities TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS join_tokens (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER);
-- On a satellite: events the hub hasn't acknowledged yet. AUTOINCREMENT so an id is never reused.
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, kind TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL
);
-- On the hub: commands for satellites (spawn, kill, …), kept until the satellite's cmd event acknowledges them.
CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL,
  created_at TEXT NOT NULL, acked_at TEXT, result TEXT
);
CREATE INDEX IF NOT EXISTS commands_pending ON commands (host, acked_at);
`;

/** Opens (and migrates) the store. Only the broker process calls this. */
export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Columns added after phase 1 shipped; ALTER fails harmlessly when they exist.
  // usage: latest normalized usage JSON (src/usage.mjs); kept as the final total once the agent ends.
  // billing: 'api' (the vendor's API key) or 'plan' (the slot's sign-in), fixed when the agent starts.
  // auto: pick options (JSON) of a spawn whose vendor the rotation chose; while queued it may move to a vendor with headroom.
  // usage_start: the vendor's window readings at launch (src/usage.mjs windowSnapshot), for per-task deltas.
  for (const col of ["role TEXT NOT NULL DEFAULT 'impl'", 'depends_on TEXT', 'start_from TEXT', 'usage TEXT', 'billing TEXT', 'usage_start TEXT', 'effort TEXT', 'paused_state TEXT', 'unpark TEXT', 'auto TEXT']) {
    try { db.exec(`ALTER TABLE agents ADD COLUMN ${col}`); } catch {}
  }
  try { db.exec('ALTER TABLE asks ADD COLUMN nonce TEXT'); } catch {}
  // Test watchdog: attempt counts reruns after a lost runner; retry_note says why ("retrying (2/3): …").
  for (const col of ['attempt INTEGER NOT NULL DEFAULT 1', 'retry_note TEXT']) {
    try { db.exec(`ALTER TABLE tests ADD COLUMN ${col}`); } catch {}
  }
  // Per-delegator merge settings: gate (hauptling test job before merging), automerge (broker merges rather than stopping at [ready]).
  for (const col of ['gate INTEGER NOT NULL DEFAULT 1', 'automerge INTEGER NOT NULL DEFAULT 1']) {
    try { db.exec(`ALTER TABLE delegators ADD COLUMN ${col}`); } catch {}
  }
  // Several hosts: where an agent or test job runs ('hub' = this machine).
  for (const t of ['agents', 'tests']) {
    try { db.exec(`ALTER TABLE ${t} ADD COLUMN host TEXT NOT NULL DEFAULT 'hub'`); } catch {}
  }
  // Part 2: placement (delegators.host NULL = auto; agents.want_host = a `spawn --host` pin; agents.gpu = `spawn --gpu`),
  // and asks.remote_id = the satellite's own id for a question mirrored to the hub.
  for (const [t, col] of [['delegators', 'host TEXT'], ['agents', 'want_host TEXT'], ['agents', 'gpu INTEGER NOT NULL DEFAULT 0'], ['asks', 'remote_id INTEGER']]) {
    try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${col}`); } catch {}
  }
  return db;
}

export const kvGet = (db, key) => db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
export const kvDel = (db, key) => db.prepare('DELETE FROM kv WHERE key = ?').run(key);
export const kvSet = (db, key, value) => db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
