/*
 * Usage normalizers (phase 4b). Every vendor's data becomes:
 *   { model, tokens_in, tokens_out, context_pct, cost_usd, cost_estimated,
 *     limits: [{ window: '5h' | 'week' | '<n>m', used_pct, resets_at: ISO | null }] }
 * Sources: Claude and agy status line JSON (forwarded by `hauptling usage <vendor>`), Codex's
 * session log (`rollout-*.jsonl`, last `token_count` event; not a stable format upstream).
 * Nothing here costs model tokens. agy's payload carries the signed-in email: it is dropped.
 */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (epochS) => (num(epochS) ? new Date(epochS * 1000).toISOString() : null);
const pct = (v) => (num(v) == null ? null : Math.max(0, Math.min(100, Math.round(v * 10) / 10)));
const windowName = (minutes) => (minutes === 300 ? '5h' : minutes === 10080 ? 'week' : `${minutes}m`);

/** API-equivalent cost from models.json prices (USD per million tokens); null when a price is unknown. */
export function estimateCost(price, tokensIn, tokensOut) {
  if (!price || num(price.usd_in) == null || num(price.usd_out) == null || tokensIn == null || tokensOut == null) return null;
  return Math.round(((tokensIn * price.usd_in + tokensOut * price.usd_out) / 1e6) * 10000) / 10000;
}

function withCost(u, reported, price, { api = false, estimatedFlag = false } = {}) {
  // API work is never free: a 0 beside used tokens means the vendor didn't count it.
  const uncounted = api && reported === 0 && (u.tokens_in > 0 || u.tokens_out > 0);
  if (num(reported) != null && !uncounted) return { ...u, cost_usd: reported, cost_estimated: Boolean(estimatedFlag) };
  return { ...u, cost_usd: estimateCost(price, u.tokens_in, u.tokens_out), cost_estimated: true };
}

function claude(j, price, api) {
  const cw = j.context_window || {};
  const limits = [['5h', j.rate_limits?.five_hour], ['week', j.rate_limits?.seven_day]]
    .filter(([, l]) => l && num(l.used_percentage) != null)
    .map(([window, l]) => ({ window, used_pct: pct(l.used_percentage), resets_at: iso(l.resets_at) }));
  const u = { model: j.model?.id || null, tokens_in: num(cw.total_input_tokens), tokens_out: num(cw.total_output_tokens), context_pct: pct(cw.used_percentage), limits };
  return withCost(u, reportedCost('claude', j), price, { api });
}

function agy(j, price, api) {
  const cw = j.context_window || {};
  // Quota arrives as *remaining* per bucket (3p-5h, gemini-5h, 3p-weekly, gemini-weekly); keep the fullest bucket per window.
  const byWindow = {};
  for (const [name, q] of Object.entries(j.quota || {})) {
    const window = /5h$/.test(name) ? '5h' : /week/.test(name) ? 'week' : null;
    if (!window || num(q?.remaining_fraction) == null) continue;
    const used = pct((1 - q.remaining_fraction) * 100);
    // An unset reset comes as "", 0 or the epoch ("1970-01-01T00:00:00Z"): none of them is a time.
    // (`Date.parse` reads "0" and 0 as the year 2000, hence the date shape.)
    const resets = /^\d{4}-/.test(q.reset_time) && Date.parse(q.reset_time) > 0 ? q.reset_time : num(q.reset_in_seconds) > 0 ? new Date(Date.now() + q.reset_in_seconds * 1000).toISOString() : null;
    if (!byWindow[window] || used > byWindow[window].used_pct) byWindow[window] = { window, used_pct: used, resets_at: resets };
  }
  const u = { model: j.model?.id || null, tokens_in: num(cw.total_input_tokens), tokens_out: num(cw.total_output_tokens), context_pct: pct(cw.used_percentage), limits: Object.values(byWindow) };
  return withCost(u, reportedCost('agy', j), price, { api, estimatedFlag: j.cost?.estimated });
}

function codex(p, price, api) {
  const info = p.info || {};
  const total = info.total_token_usage || {};
  const last = info.last_token_usage || {};
  const ctx = num(info.model_context_window) && num(last.total_tokens) != null ? (last.total_tokens / info.model_context_window) * 100 : null;
  const limits = ['primary', 'secondary'].map(k => p.rate_limits?.[k]).filter(l => l && num(l.used_percent) != null)
    .map(l => ({ window: windowName(l.window_minutes), used_pct: pct(l.used_percent), resets_at: iso(l.resets_at) }));
  const u = { model: null, tokens_in: num(total.input_tokens), tokens_out: num(total.output_tokens), context_pct: pct(ctx), limits };
  return withCost(u, null, price, { api });
}

/** The cost the vendor itself put in its payload, or null. */
export function reportedCost(vendor, payload) {
  return num(vendor === 'claude' ? payload?.cost?.total_cost_usd : vendor === 'agy' ? payload?.cost?.total_usd : null);
}

/**
 * Vendor payload → normalized usage. `price` is the agent's models.json entry ({ usd_in, usd_out });
 * `api`: the agent is billed on an API key.
 */
export function normalizeUsage(vendor, payload, price = null, { api = false } = {}) {
  if (!payload || typeof payload !== 'object') throw new Error('usage payload must be an object');
  if (vendor === 'claude') return claude(payload, price, api);
  if (vendor === 'agy') return agy(payload, price, api);
  if (vendor === 'codex') return codex(payload, price, api);
  throw new Error(`Unknown vendor ${vendor}`);
}

const add = (a, b) => (a == null && b == null ? null : Math.round(((a || 0) + (b || 0)) * 10000) / 10000);
const less = (a, b) => a != null && b != null && a < b;
const totals = (base, s) => ({ tokens_in: add(base?.tokens_in, s.tokens_in), tokens_out: add(base?.tokens_out, s.tokens_out),
  cost_usd: add(base?.cost_usd, s.cost_usd), cost_estimated: Boolean(base?.cost_estimated || s.cost_estimated) });

/**
 * An agent's stored usage `prev` plus the latest reading `u` of one CLI session → totals across sessions.
 * `session` keeps the current session's own numbers, `base` the sum of the finished ones. A new session: a
 * changed session id or a lower reported cost; for Codex, whose log counts cumulatively, also lower token
 * totals (Claude's are the current context, which shrinks within a session). Rows without `session` predate this.
 */
export function accumulate(prev, u, { vendor, sessionId = null, reported = null }) {
  const old = prev && (prev.session || { tokens_in: prev.tokens_in, tokens_out: prev.tokens_out, cost_usd: prev.cost_usd,
    cost_estimated: prev.cost_estimated, reported: prev.cost_estimated ? null : prev.cost_usd });
  const fresh = Boolean(old) && ((sessionId && old.id && sessionId !== old.id) || less(reported, old.reported)
    || (vendor === 'codex' && (less(u.tokens_in, old.tokens_in) || less(u.tokens_out, old.tokens_out))));
  const base = fresh ? totals(prev.base, old) : prev?.base || null;
  const same = (!fresh && old) || {};
  const keepCost = u.cost_usd == null || (u.cost_estimated && same.cost_usd > u.cost_usd);
  const session = { id: sessionId || same.id || null, tokens_in: u.tokens_in ?? same.tokens_in ?? null, tokens_out: u.tokens_out ?? same.tokens_out ?? null,
    cost_usd: keepCost ? same.cost_usd ?? null : u.cost_usd, cost_estimated: keepCost ? same.cost_estimated ?? u.cost_estimated : u.cost_estimated,
    reported: reported ?? same.reported ?? null };
  return { ...u, ...totals(base, session), session, ...(base ? { base } : {}) };
}

/**
 * What a vendor's TUI prints when an API key has no credit left, matched at the start of a screen line
 * (after the TUI's own glyphs). Extend with real wording only; agy's is unknown.
 */
export const OUT_OF_CREDIT = {
  claude: [/^[\s⎿│┃●⏺■*!>-]*Credit balance (?:is )?too low/im],
  // openai/codex codex-rs/protocol/src/error.rs
  codex: [/^[\s⎿│┃●⏺■•⚠*>!-]*Quota exceeded\. Check your plan and billing details/im,
    /^[\s⎿│┃●⏺■•⚠*>!-]*Your (?:API key|project|organization) has reached its spend limit/im],
  agy: [],
};
export const outOfCredit = (vendor, screen) => (OUT_OF_CREDIT[vendor] || []).some(re => re.test(String(screen)));

/** What a worker forwards: the status line JSON minus personal fields. */
export function scrub(payload) {
  const { email: _e, user_email: _u, account: _a, ...rest } = payload || {};
  return rest;
}

/** Last `token_count` payload in the tail of a Codex rollout file (text), or null. */
export function lastTokenCount(text) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"token_count"')) continue;
    try {
      const d = JSON.parse(lines[i]);
      if (d.payload?.type === 'token_count' && (d.payload.info || d.payload.rate_limits)) return d.payload;
    } catch {}
  }
  return null;
}

/** Short text a worker's status line shows (the vendor TUI prints it). */
export function statusText(u) {
  const parts = [];
  if (u.context_pct != null) parts.push(`ctx ${Math.round(u.context_pct)}%`);
  if (u.cost_usd != null) parts.push(`${u.cost_estimated ? '~' : ''}$${u.cost_usd.toFixed(2)}`);
  for (const l of u.limits) parts.push(`${l.window} ${Math.round(l.used_pct)}%`);
  return `hauptling · ${parts.join(' · ') || 'usage pending'}`;
}

/** What to show for a window with no reset time. Nothing used and no reset: the window hasn't started. */
export const noReset = (usedPct) => (usedPct === 0 ? 'not started' : 'no reset time');

/** Newest reading of each of a vendor's account windows, from any slot: { [window]: { used_pct, resets_at } }. */
export function windowSnapshot(db, vendor) {
  const out = {};
  for (const r of db.prepare('SELECT window, used_pct, resets_at FROM slot_usage WHERE vendor = ? ORDER BY at DESC').all(vendor)) {
    out[r.window] ||= { used_pct: r.used_pct, resets_at: r.resets_at };
  }
  return out;
}

const kfmt = (n) => (n == null ? '?' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/**
 * One line of what a task spent: tokens, cost, points each window rose since launch, test rounds.
 * A window that had no reading at launch, or whose reset time changed (it reset mid-task), shows no delta.
 */
export function spendLine({ usage, start, now, rounds }) {
  const parts = [];
  if (usage) {
    parts.push(`${kfmt(usage.tokens_in)} in/${kfmt(usage.tokens_out)} out tok`);
    if (usage.cost_usd != null) parts.push(`${usage.cost_estimated ? '~' : ''}$${usage.cost_usd.toFixed(2)}`);
  }
  for (const [w, n] of Object.entries(now || {})) {
    const s = start?.[w];
    if (!s || s.resets_at !== n.resets_at) continue;
    parts.push(`${w} +${Math.max(0, Math.round(n.used_pct - s.used_pct))}`);
  }
  parts.push(`${rounds} test round${rounds === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
