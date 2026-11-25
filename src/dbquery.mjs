import { spawn } from 'node:child_process';

/*
 * Ad-hoc SQL for the dashboard's explorer: a read-only connection in a short-lived child process,
 * so a runaway query is SIGKILLed (node:sqlite has no interrupt, and a worker thread stuck inside
 * SQLite can't be terminated) and a write is impossible, not just refused.
 */

const SOURCE = `
const { DatabaseSync } = require('node:sqlite');
let input = '';
process.stdin.on('data', d => { input += d; }).on('end', () => {
  const { path, sql, limit } = JSON.parse(input);
  let out;
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    const stmt = db.prepare(sql);
    const columns = stmt.columns().map(c => c.name);
    const rows = [];
    let truncated = false;
    for (const r of stmt.iterate()) {
      if (rows.length >= limit) { truncated = true; break; }
      rows.push(columns.map(c => (typeof r[c] === 'bigint' ? String(r[c]) : r[c] instanceof Uint8Array ? '<blob ' + r[c].length + ' bytes>' : r[c])));
    }
    out = { columns, rows, truncated };
  } catch (e) { out = { error: e.message }; }
  process.stdout.write(JSON.stringify(out));
});
`;

const READ = /^\s*(select|with|explain)\b/i;

/** Runs one SELECT/WITH/EXPLAIN on `path` read-only; at most `limit` rows within `ms`. */
export function readOnlyQuery(path, sql, { limit = 1000, ms = 2000 } = {}) {
  if (!READ.test(sql)) return Promise.reject(new Error('Only SELECT, WITH or EXPLAIN queries'));
  if (path === ':memory:') return Promise.reject(new Error('No database file'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '-e', SOURCE], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, ms);
    child.stdout.on('data', d => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`Query took longer than ${ms / 1000} s`));
      try { const m = JSON.parse(out); if (m.error) reject(new Error(m.error)); else resolve(m); }
      catch { reject(new Error('Query failed')); }
    });
    child.stdin.end(JSON.stringify({ path, sql, limit }));
  });
}
