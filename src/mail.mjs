import { MAIL_MAX, STATUS_MAX, assertIdentity, bounded, identityFor, isFamily, isIdentity, now, sanitizeModel } from './util.mjs';
import { tx } from './db.mjs';

/*
 * Machine-wide mailbox (ported from nullpunkt's scripts/coagent/store.mjs into SQLite).
 * Identity: `<family>_<model>_<key>`. Messages ≤300 chars, status ≤100. Delivery claims a message
 * by setting seen_at, so each recipient gets each message once. `user` and `hauptling` are
 * reserved senders (answers from you, notices from the broker).
 */

export function formatMail(m) {
  const at = new Date(m.at);
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return `[${String(m.sender).split('_').pop()} ${hhmm}] ${m.text}`;
}

/** Registers a hand-started session by its session id (or returns its identity). Upgrades `unknown` models. */
export function register(db, family, sessionId, model, repo = null) {
  if (!isFamily(family)) throw new Error(`Family must be claude, codex or agy, got "${family}"`);
  const known = sanitizeModel(model);
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM identities WHERE session_id = ?').get(String(sessionId));
    if (row) {
      db.prepare('UPDATE identities SET seen_at = ?, repo = COALESCE(?, repo) WHERE identity = ?').run(now(), repo, row.identity);
      if (row.model === 'unknown' && known !== 'unknown') {
        const identity = identityFor(family, known, sessionId);
        rename(db, row.identity, identity, known);
        return identity;
      }
      return row.identity;
    }
    const identity = identityFor(family, known, sessionId);
    db.prepare('INSERT INTO identities (identity, family, model, session_id, repo, seen_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (identity) DO UPDATE SET seen_at = excluded.seen_at')
      .run(identity, family, known, String(sessionId), repo, now());
    return identity;
  });
}

function rename(db, from, to, model) {
  db.prepare('UPDATE identities SET identity = ?, model = ? WHERE identity = ?').run(to, model, from);
  db.prepare('UPDATE status SET identity = ? WHERE identity = ?').run(to, from);
  db.prepare('UPDATE mail SET recipient = ? WHERE recipient = ?').run(to, from);
}

/** Adds a spawned worker's identity (fixed at spawn). */
export function addIdentity(db, identity, family, model, repo) {
  db.prepare('INSERT OR REPLACE INTO identities (identity, family, model, session_id, repo, seen_at) VALUES (?, ?, ?, NULL, ?, ?)')
    .run(identity, family, model, repo, now());
}

export const touch = (db, identity) => db.prepare('UPDATE identities SET seen_at = ? WHERE identity = ?').run(now(), identity);

/** A full identity, or a unique suffix of its key (5+ hex characters). */
export function resolve(db, name) {
  if (isIdentity(name)) return name;
  if (!/^[0-9a-f]{5,32}$/.test(name || '')) return assertIdentity(name);
  const found = db.prepare('SELECT identity FROM identities').all().map(r => r.identity).filter(id => id.split('_').pop().endsWith(name));
  if (found.length !== 1) throw new Error(found.length ? `${name} is ambiguous: ${found.join(', ')}` : `No identity ends in ${name}`);
  return found[0];
}

/** An identity/key, or every registered identity of a family (broadcast). */
export function targets(db, to) {
  if (isFamily(to)) {
    const found = db.prepare('SELECT identity FROM identities WHERE family = ? ORDER BY identity').all(to).map(r => r.identity);
    if (!found.length) throw new Error(`No registered ${to} identity`);
    return found;
  }
  return [resolve(db, to)];
}

const SENDERS = new Set(['user', 'hauptling']);

export function send(db, from, to, text) {
  if (!SENDERS.has(from)) assertIdentity(from);
  const recipients = targets(db, to);
  const body = bounded(text, MAIL_MAX, 'Mail');
  const at = now();
  const ins = db.prepare('INSERT INTO mail (recipient, sender, text, at) VALUES (?, ?, ?, ?)');
  tx(db, () => { for (const r of recipients) if (r !== from) ins.run(r, from, body, at); });
  return recipients.filter(r => r !== from);
}

/** Claims up to `limit` unread messages for an identity, formatted. */
export function take(db, identity, limit = 5) {
  return tx(db, () => {
    const rows = db.prepare('SELECT * FROM mail WHERE recipient = ? AND seen_at IS NULL ORDER BY id LIMIT ?').all(identity, limit);
    const mark = db.prepare('UPDATE mail SET seen_at = ? WHERE id = ?');
    for (const r of rows) mark.run(now(), r.id);
    return rows.map(formatMail);
  });
}

export const unread = (db, identity) => db.prepare('SELECT COUNT(*) n FROM mail WHERE recipient = ? AND seen_at IS NULL').get(identity).n;

export function setStatus(db, identity, text) {
  assertIdentity(identity);
  db.prepare('INSERT INTO status (identity, text, at) VALUES (?, ?, ?) ON CONFLICT (identity) DO UPDATE SET text = excluded.text, at = excluded.at')
    .run(identity, bounded(text, STATUS_MAX, 'Status'), now());
  touch(db, identity);
}

/** Status board lines. Hides identities without status and `done` older than 3 h unless `all`. */
export function peers(db, all = false, at = Date.now()) {
  prune(db, 12, at);
  const rows = db.prepare('SELECT i.identity, i.repo, s.text, s.at FROM identities i LEFT JOIN status s USING (identity) ORDER BY i.identity').all();
  return rows.filter(r => all || (r.text && !(/^done/i.test(r.text) && at - Date.parse(r.at) > 3 * 3600e3)))
    .map(r => `${r.identity}${r.repo ? ` [${r.repo}]` : ''}: ${r.text || 'no status'}`);
}

/**
 * Drops hand-started identities not seen for `hours` (72 h when working/blocked, unless force),
 * with their status and mail. Spawned workers (no session id) live as long as their agent row.
 */
export function prune(db, hours = 12, at = Date.now(), force = false) {
  const rows = db.prepare(`SELECT i.identity, i.seen_at, s.text, s.at status_at FROM identities i LEFT JOIN status s USING (identity)
    WHERE i.session_id IS NOT NULL OR i.identity NOT IN (SELECT id FROM agents)`).all();
  const removed = [];
  tx(db, () => {
    for (const r of rows) {
      const seen = Math.max(Date.parse(r.seen_at) || 0, Date.parse(r.status_at) || 0);
      const limit = !force && /^(working|blocked)/i.test(r.text || '') ? 72 : hours;
      if (at - seen < limit * 3600e3) continue;
      for (const t of ['identities', 'status']) db.prepare(`DELETE FROM ${t} WHERE identity = ?`).run(r.identity);
      db.prepare('DELETE FROM mail WHERE recipient = ?').run(r.identity);
      removed.push(r.identity);
    }
  });
  return removed.sort();
}
