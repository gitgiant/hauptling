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

function withCost(u, reported, price, estimatedFlag = false) {
  if (num(reported) != null) return { ...u, cost_usd: reported, cost_estimated: Boolean(estimatedFlag) };
  return { ...u, cost_usd: estimateCost(price, u.tokens_in, u.tokens_out), cost_estimated: true };
}

function claude(j, price) {
  const cw = j.context_window || {};
  const limits = [['5h', j.rate_limits?.five_hour], ['week', j.rate_limits?.seven_day]]
    .filter(([, l]) => l && num(l.used_percentage) != null)
    .map(([window, l]) => ({ window, used_pct: pct(l.used_percentage), resets_at: iso(l.resets_at) }));
  const u = { model: j.model?.id || null, tokens_in: num(cw.total_input_tokens), tokens_out: num(cw.total_output_tokens), context_pct: pct(cw.used_percentage), limits };
  return withCost(u, j.cost?.total_cost_usd, price);
}

function agy(j, price) {
  const cw = j.context_window || {};
  // Quota arrives as *remaining* per bucket (3p-5h, gemini-5h, 3p-weekly, gemini-weekly); keep the fullest bucket per window.
  const byWindow = {};
  for (const [name, q] of Object.entries(j.quota || {})) {
    const window = /5h$/.test(name) ? '5h' : /week/.test(name) ? 'week' : null;
    if (!window || num(q?.remaining_fraction) == null) continue;
    const used = pct((1 - q.remaining_fraction) * 100);
    const resets = q.reset_time || (num(q.reset_in_seconds) != null ? new Date(Date.now() + q.reset_in_seconds * 1000).toISOString() : null);
    if (!byWindow[window] || used > byWindow[window].used_pct) byWindow[window] = { window, used_pct: used, resets_at: resets };
  }
  const u = { model: j.model?.id || null, tokens_in: num(cw.total_input_tokens), tokens_out: num(cw.total_output_tokens), context_pct: pct(cw.used_percentage), limits: Object.values(byWindow) };
  return withCost(u, j.cost?.total_usd, price, j.cost?.estimated);
}

function codex(p, price) {
  const info = p.info || {};
  const total = info.total_token_usage || {};
  const last = info.last_token_usage || {};
  const ctx = num(info.model_context_window) && num(last.total_tokens) != null ? (last.total_tokens / info.model_context_window) * 100 : null;
  const limits = ['primary', 'secondary'].map(k => p.rate_limits?.[k]).filter(l => l && num(l.used_percent) != null)
    .map(l => ({ window: windowName(l.window_minutes), used_pct: pct(l.used_percent), resets_at: iso(l.resets_at) }));
  const u = { model: null, tokens_in: num(total.input_tokens), tokens_out: num(total.output_tokens), context_pct: pct(ctx), limits };
  return withCost(u, null, price);
}

/** Vendor payload → normalized usage. `price` is the agent's models.json entry ({ usd_in, usd_out }). */
export function normalizeUsage(vendor, payload, price = null) {
  if (!payload || typeof payload !== 'object') throw new Error('usage payload must be an object');
  if (vendor === 'claude') return claude(payload, price);
  if (vendor === 'agy') return agy(payload, price);
  if (vendor === 'codex') return codex(payload, price);
  throw new Error(`Unknown vendor ${vendor}`);
}

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
