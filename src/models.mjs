import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { home } from './util.mjs';
import { kvGet, kvSet } from './db.mjs';

const SHIPPED = fileURLToPath(new URL('../models.json', import.meta.url));

function merge(a, b) {
  if (Array.isArray(b) || typeof b !== 'object' || b === null) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
  return out;
}

/** Shipped models.json deep-merged with ~/.hauptling/models.json (arrays replace). */
export function loadModels(override = join(home(), 'models.json')) {
  const base = JSON.parse(readFileSync(SHIPPED, 'utf8'));
  return existsSync(override) ? merge(base, JSON.parse(readFileSync(override, 'utf8'))) : base;
}

export function enabledVendors(cfg) {
  return (cfg.order || Object.keys(cfg.vendors)).filter(v => cfg.vendors[v]?.enabled !== false);
}

export function findModel(cfg, vendor, id) {
  const v = cfg.vendors[vendor];
  if (!v) throw new Error(`Unknown vendor ${vendor}`);
  const m = v.models.find(m => m.id === id || m.model === id);
  if (!m) throw new Error(`No ${vendor} model "${id}" in models.json (have: ${v.models.map(m => m.id).join(', ')})`);
  return m;
}

/** Cheaper-model preference → highest tier spawn may use without --allow-tier. */
export const PREFER = { cheap: 1, balanced: 2, best: 3 };
export const preferOf = (cfg) => (cfg.prefer in PREFER ? cfg.prefer : 'best');
export const maxTier = (cfg) => PREFER[preferOf(cfg)];

/** Writes `prefer` into the user's override file, keeping everything else in it. */
export function setPrefer(value, override = join(home(), 'models.json')) {
  if (!(value in PREFER)) throw new Error(`prefer must be ${Object.keys(PREFER).join(', ')}; got "${value}"`);
  const cur = existsSync(override) ? JSON.parse(readFileSync(override, 'utf8') || '{}') : {};
  cur.prefer = value;
  mkdirSync(dirname(override), { recursive: true });
  writeFileSync(override, JSON.stringify(cur, null, 2) + '\n');
  return value;
}

/** Throws when a model is above the preference cap and the spawn didn't pass --allow-tier. */
export function checkTier(cfg, vendor, entry, allowTier = false) {
  if (allowTier || entry.tier <= maxTier(cfg)) return entry;
  throw new Error(`prefer=${preferOf(cfg)} caps workers at tier ${maxTier(cfg)}; ${vendor} ${entry.id} is tier ${entry.tier}. Pick a cheaper model or pass --allow-tier.`);
}

/**
 * Picks a model for a vendor. cheapest: lowest tier. rule: tier from rules[difficulty].
 * suggest: no pick; the delegator reasons over `hauptling models` and passes --model.
 */
export function pick(cfg, vendor, mode = 'suggest', difficulty = 'normal') {
  const models = cfg.vendors[vendor]?.models || [];
  if (!models.length) throw new Error(`No models for ${vendor}`);
  if (mode === 'cheapest') return [...models].sort((a, b) => a.tier - b.tier)[0];
  if (mode === 'rule') {
    const ruled = cfg.rules?.[difficulty];
    if (!ruled) throw new Error(`No rule for difficulty "${difficulty}" (have: ${Object.keys(cfg.rules || {}).join(', ')})`);
    const tier = Math.min(ruled, maxTier(cfg)); // the preference caps rule mode
    return models.find(m => m.tier === tier) || [...models].sort((a, b) => Math.abs(a.tier - tier) - Math.abs(b.tier - tier))[0];
  }
  throw new Error('Suggest mode: choose a model from `hauptling models` and pass --model (or use --mode cheapest|rule)');
}

/** Round robin over enabled vendors: claude, codex, agy, claude… State lives in the store. */
export function nextVendor(db, cfg) {
  const order = enabledVendors(cfg);
  if (!order.length) throw new Error('No vendor enabled in models.json');
  const last = kvGet(db, 'rr_vendor');
  const next = order[(order.indexOf(last) + 1) % order.length];
  kvSet(db, 'rr_vendor', next);
  return next;
}

/** Reasoning effort for a worker: spawn --effort, else the model entry's, else the tier default. null = vendor default. */
export function effortFor(cfg, vendor, entry, override) {
  const v = cfg.vendors[vendor];
  if (override && !v.effortArgs) throw new Error(`${vendor} takes no --effort (its model ids carry the effort; pick another model)`);
  return v.effortArgs ? override || entry.effort || cfg.effort?.[entry.tier] || null : null;
}

/** argv for a vendor's TUI with a model entry, initial prompt and optional effort. */
export function launchArgv(cfg, vendor, entry, prompt, effort = null) {
  const v = cfg.vendors[vendor];
  const argv = v.launch.map(a => a.replaceAll('{model}', entry.model || entry.id).replaceAll('{prompt}', prompt));
  const eff = effort && v.effortArgs ? v.effortArgs.map(a => a.replaceAll('{effort}', effort)) : [];
  // Extra model args go right after the binary so a trailing positional prompt stays last.
  return [argv[0], ...eff, ...(entry.args || []), ...argv.slice(1)];
}

export function table(cfg) {
  const lines = [`prefer: ${preferOf(cfg)} (workers up to tier ${maxTier(cfg)}; above it only with --allow-tier). Change: hauptling models prefer cheap|balanced|best`];
  for (const v of enabledVendors(cfg)) {
    for (const m of cfg.vendors[v].models) {
      const price = m.usd_in == null ? 'price ?' : `$${m.usd_in}/$${m.usd_out} per Mtok`;
      const eff = effortFor(cfg, v, m);
      lines.push(`${v.padEnd(7)} ${m.id.padEnd(26)} tier ${m.tier}  ${eff ? `effort ${eff}  ` : ''}${price}${m.notes ? `  ${m.notes}` : ''}${m.tier > maxTier(cfg) ? '  (above prefer)' : ''}`);
    }
  }
  return lines.join('\n');
}
