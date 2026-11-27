/*
 * "Refresh usage" (PRD "Usage refresh"): what each vendor's own CLI is asked, and how its answer becomes
 * limit windows. No model call in any of them. The commands run in a throwaway container (src/docker.mjs
 * `usageProbe`); these functions only build argv and parse output.
 *   claude  `claude -p /usage` answers locally (verified on 2.1.332: 0 turns, 0 tokens)
 *   codex   `codex app-server`, JSON-RPC `account/rateLimits/read` (method and shape from 0.172.0)
 *   agy     `agy --output-format json --print /usage` (print-mode slash commands, agy ≥ 1.1.11)
 */
import { normalizeUsage } from './usage.mjs';

export const PROBE = {
  claude: ['claude', '-p', '/usage', '--output-format', 'json', '--no-session-persistence'],
  codex: ['codex', 'app-server'],
  agy: ['agy', '--output-format', 'json', '--print', '/usage'],
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Claude's "Nov 27, 10:40am (UTC)" (date optional, no year) → ISO of the next such time; null if not UTC or unreadable. */
export function claudeReset(text, now = Date.now()) {
  const m = /^(?:([A-Za-z]{3})[a-z]* (\d{1,2})(?:, (\d{4}))?(?:,| at) )?(\d{1,2})(?::(\d\d))?\s*([ap]m) \((?:UTC|Etc\/UTC)\)/i.exec(String(text).trim());
  if (!m) return null;
  const [, mon, day, year, h, min = '0', ap] = m;
  const hour = (Number(h) % 12) + (ap.toLowerCase() === 'pm' ? 12 : 0);
  const d = new Date(now);
  const slack = 3600e3; // a reset a moment ago is still this one
  if (!mon) {
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, Number(min));
    if (t < now - slack) t += 86400e3;
    return new Date(t).toISOString();
  }
  const month = MONTHS.indexOf(mon.toLowerCase());
  if (month < 0) return null;
  let t = Date.UTC(Number(year) || d.getUTCFullYear(), month, Number(day), hour, Number(min));
  if (!year && t < now - 30 * 86400e3) t = Date.UTC(d.getUTCFullYear() + 1, month, Number(day), hour, Number(min));
  return new Date(t).toISOString();
}

function claude(stdout, now) {
  let j;
  try { j = JSON.parse(stdout); } catch { throw new Error('claude /usage gave no JSON'); }
  if (j.is_error) throw new Error(String(j.result || 'claude /usage failed'));
  if (j.num_turns > 0) throw new Error('claude ran /usage as a model turn (CLI changed?)');
  const limits = [];
  for (const [window, label] of [['5h', 'Current session'], ['week', 'Current week \\(all models\\)']]) {
    const m = new RegExp(`^${label}: ([\\d.]+)% used(?:.*?resets (.+))?$`, 'm').exec(String(j.result));
    if (m) limits.push({ window, used_pct: Math.min(100, Number(m[1])), resets_at: m[2] ? claudeReset(m[2], now) : null });
  }
  return limits;
}

/** `result` of `account/rateLimits/read`: the same windows as the session log, in camelCase. */
function codex(result) {
  const r = result?.rateLimits;
  const win = (w) => w && { used_percent: w.usedPercent, window_minutes: w.windowDurationMins, resets_at: w.resetsAt };
  return normalizeUsage('codex', { rate_limits: { primary: win(r?.primary), secondary: win(r?.secondary) } }).limits;
}

/** Every quota bucket (`{ window, remaining_fraction, reset_time }`) anywhere in agy's answer, per window the fullest. */
function agy(stdout) {
  let j;
  try { j = JSON.parse(stdout.slice(stdout.indexOf('{'))); } catch { throw new Error('agy /usage gave no JSON'); }
  if (j.error) throw new Error(String(j.error));
  const quota = {};
  let n = 0;
  const walk = (v) => {
    if (typeof v === 'string' && v.startsWith('{')) { try { walk(JSON.parse(v)); } catch {} return; }
    if (!v || typeof v !== 'object') return;
    if (typeof v.remaining_fraction === 'number' && !v.disabled) {
      const name = [v.window, v.id, v.name].filter(Boolean).join(' ');
      const window = /(^|[^\d])5[ _-]?h|five.?hour/i.test(name) ? '5h' : /week|(^|[^\d])7[ _-]?d/i.test(name) ? 'week' : null;
      if (window) quota[`${n++}-${window === 'week' ? 'weekly' : '5h'}`] = { remaining_fraction: v.remaining_fraction, reset_time: v.reset_time };
    }
    Object.values(v).forEach(walk);
  };
  walk(j);
  return normalizeUsage('agy', { quota }).limits;
}

/** A probe's output (stdout text; for codex the RPC result) → limit windows. Throws when there are none. */
export function parseProbe(vendor, output, now = Date.now()) {
  const limits = vendor === 'claude' ? claude(output, now) : vendor === 'codex' ? codex(output) : agy(String(output));
  if (!limits.length) throw new Error(`no plan usage in ${vendor}'s answer (not on a subscription, or its format changed)`);
  return limits;
}

/** An error as one short line for a card: no URLs (agy prints sign-in links). */
export const shortError = (message) => String(message).replace(/https?:\/\/\S+/g, '<url>').replace(/\s+/g, ' ').trim().slice(0, 160);
