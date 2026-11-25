import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { home } from './util.mjs';

/*
 * API keys (optional, per vendor). A stored key switches that vendor to API billing for every slot:
 * workers get the key in their environment instead of the slot's subscription sign-in. Keys don't
 * rotate, so one key serves all slots. Removing it switches the vendor back to the slots' sign-ins.
 *   claude: ANTHROPIC_API_KEY (pre-approved in the slot's .claude.json by `prepare`)
 *   codex:  OPENAI_API_KEY, stored by `codex login --with-api-key` in a separate CODEX_HOME
 *           (<slot>/codex-key) so the slot's ChatGPT sign-in in <slot>/codex is left alone
 *   agy:    GEMINI_API_KEY
 * Files: ~/.hauptling/keys/<vendor>, mode 600, directory 700.
 *
 * Budget (optional, ~/.hauptling/keys/<vendor>.budget.json): API first, then the plan. Spawns take the key
 * while this period's API spend is under STOP_AT of the budget, else the slots' sign-ins (PRD "API keys").
 */

export const KEY_ENV = { claude: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY', agy: 'GEMINI_API_KEY' };
const dir = () => join(home(), 'keys');
const file = (vendor) => {
  if (!KEY_ENV[vendor]) throw new Error(`Unknown vendor ${vendor} (claude, codex or agy)`);
  return join(dir(), vendor);
};

export function getKey(vendor) {
  const f = file(vendor);
  return existsSync(f) ? readFileSync(f, 'utf8').trim() || null : null;
}

export function setKey(vendor, key) {
  const k = String(key || '').trim();
  if (k.length < 20 || /\s/.test(k)) throw new Error('That does not look like an API key (expected one line, 20+ characters)');
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  chmodSync(dir(), 0o700);
  writeFileSync(file(vendor), `${k}\n`, { mode: 0o600 });
  chmodSync(file(vendor), 0o600);
  return { vendor, hint: hint(k) };
}

export function removeKey(vendor) {
  const f = file(vendor);
  const had = existsSync(f);
  rmSync(f, { force: true });
  rmSync(budgetFile(vendor), { force: true });
  return { vendor, removed: had };
}

// ---------- monthly budget ----------

/** New API spawns stop at this share of the budget; the rest covers workers still running on the API. */
export const STOP_AT = 0.9;
const budgetFile = (vendor) => `${file(vendor)}.budget.json`;

/** { usd, resets_on } or null (no budget: the key covers every slot). */
export function getBudget(vendor) {
  try {
    const b = JSON.parse(readFileSync(budgetFile(vendor), 'utf8'));
    return b.usd > 0 ? { usd: b.usd, resets_on: b.resets_on || 1 } : null;
  } catch { return null; }
}

/** `usd` null or 'off' removes the budget. `resetsOn`: day of month the credit renews (1–28). */
export function setBudget(vendor, usd, resetsOn = 1) {
  const f = budgetFile(vendor);
  if (usd == null || usd === 'off') { rmSync(f, { force: true }); return null; }
  const n = Number(usd), day = Number(resetsOn);
  if (!(n > 0)) throw new Error(`Budget must be a positive amount in USD, got "${usd}"`);
  if (!Number.isInteger(day) || day < 1 || day > 28) throw new Error(`--resets-on must be a day 1–28, got "${resetsOn}"`);
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  writeFileSync(f, `${JSON.stringify({ usd: n, resets_on: day })}\n`, { mode: 0o600 });
  return { usd: n, resets_on: day };
}

/** Start of the current budget period (local midnight on the last `resetsOn` day), as ISO. */
export function periodStart(resetsOn = 1, at = new Date()) {
  const d = new Date(at.getFullYear(), at.getMonth(), resetsOn);
  if (d > at) d.setMonth(d.getMonth() - 1);
  return d.toISOString();
}

/** When the current period ends (the next reset), as ISO. */
export function periodEnd(resetsOn = 1, at = new Date()) {
  const d = new Date(periodStart(resetsOn, at));
  d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

/** Last 4 characters, for display. */
export const hint = (k) => (k ? `…${k.slice(-4)}` : null);

/** { claude: '…abcd' | null, … } */
export const keyHints = () => Object.fromEntries(Object.keys(KEY_ENV).map(v => [v, hint(getKey(v))]));

/** Extra container env for a worker of `vendor`: the key, and Codex's separate home. */
export function workerKeyEnv(vendor, key = getKey(vendor)) {
  if (!key) return {};
  const env = { [KEY_ENV[vendor]]: key };
  if (vendor === 'codex') env.CODEX_HOME = '/home/worker/.vendor/codex-key';
  return env;
}
