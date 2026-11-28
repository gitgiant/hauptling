import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { home } from './util.mjs';

/*
 * API keys (optional, per vendor). A stored key switches that vendor to API billing for every slot:
 * workers get the key in their environment instead of the slot's subscription sign-in. Keys don't
 * rotate, so one key serves all slots. Removing it switches the vendor back to the slots' sign-ins.
 *   claude: ANTHROPIC_API_KEY (pre-approved in the slot's .claude.json by `prepare`)
 *   codex:  OPENAI_API_KEY, stored by `codex login --with-api-key` in a separate CODEX_HOME
 *           (<slot>/codex-key) so the slot's ChatGPT sign-in in <slot>/codex is left alone
 *   agy:    GEMINI_API_KEY
 * Claude only: the key file may hold `console` instead: the host's Console sign-in is the API account (below).
 * Files: ~/.hauptling/keys/<vendor>, mode 600, directory 700.
 *
 * Budget (optional, ~/.hauptling/keys/<vendor>.budget.json): API first, then the plan. Spawns take the key
 * while this period's API spend is under STOP_AT of the budget, else the slots' sign-ins (PRD "API keys").
 *
 * Ceiling (optional, ~/.hauptling/keys/<vendor>.upto): the highest model tier the key pays for; models above
 * it go to the plan (PRD "API keys").
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
  clearExhausted(vendor);
  return { vendor, hint: hint(k) };
}

// ---------- Claude's Console sign-in as the API account (PRD "Console sign-in") ----------
/** What the key file holds when the vendor's API account is a Console sign-in, not a key. */
export const CONSOLE = 'console';
/** Where Claude Code keeps a Console sign-in ("Anthropic Console account · API usage billing"): host-wide, outside any config dir. */
export const consoleDir = () => process.env.HAUPTLING_CONSOLE_DIR || join(homedir(), '.config', 'anthropic');
/** { workspace, organization } of the host's Console sign-in, or null when there is none. */
export function consoleSignin(dir = consoleDir()) {
  try {
    const active = readFileSync(join(dir, 'active_config'), 'utf8').trim() || 'default';
    const c = JSON.parse(readFileSync(join(dir, 'credentials', `${active}.json`), 'utf8'));
    return c.access_token || c.refresh_token ? { workspace: c.workspace_name || null, organization: c.organization_name || null } : null;
  } catch { return null; }
}
/** Makes the host's Console sign-in Claude's API account: the same budget, ceiling and spend rules as a key. */
export function setConsole(vendor) {
  if (vendor !== 'claude') throw new Error('--console is for claude only (its "Anthropic Console account" sign-in)');
  const c = consoleSignin();
  if (!c) throw new Error(`No Console sign-in on this host (${consoleDir()}). Sign in first: Usage page → Claude → Sign in → "Anthropic Console account · API usage billing"`);
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  chmodSync(dir(), 0o700);
  writeFileSync(file(vendor), `${CONSOLE}\n`, { mode: 0o600 });
  clearExhausted(vendor);
  return { vendor, hint: hint(CONSOLE), ...c };
}
export const isConsole = (vendor, key = getKey(vendor)) => vendor === 'claude' && key === CONSOLE;
/**
 * Extra `docker run` mounts for an API worker on the Console sign-in: the sign-in itself (read-write: the CLI
 * refreshes its token there), and `mask`, an empty credential file laid over the slot's own, since a subscription
 * sign-in in the slot would win over it.
 */
export function workerKeyMounts(vendor, mask, key = getKey(vendor)) {
  if (!isConsole(vendor, key)) return [];
  return ['-v', `${consoleDir()}:/home/worker/.config/anthropic`, '-v', `${mask}:/home/worker/.vendor/claude/.credentials.json`];
}

export function removeKey(vendor) {
  const f = file(vendor);
  const had = existsSync(f);
  rmSync(f, { force: true });
  rmSync(budgetFile(vendor), { force: true });
  rmSync(upToFile(vendor), { force: true });
  clearExhausted(vendor);
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
  if (usd == null || usd === 'off') { rmSync(f, { force: true }); clearExhausted(vendor); return null; }
  const n = Number(usd), day = Number(resetsOn);
  if (!(n > 0)) throw new Error(`Budget must be a positive amount in USD, got "${usd}"`);
  if (!Number.isInteger(day) || day < 1 || day > 28) throw new Error(`--resets-on must be a day 1–28, got "${resetsOn}"`);
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  writeFileSync(f, `${JSON.stringify({ usd: n, resets_on: day })}\n`, { mode: 0o600 });
  clearExhausted(vendor);
  return { usd: n, resets_on: day };
}

// ---------- model-tier ceiling ----------
const upToFile = (vendor) => `${file(vendor)}.upto`;

/** Highest model tier the key pays for, or null (no ceiling). */
export function getUpTo(vendor) {
  try { return Number(readFileSync(upToFile(vendor), 'utf8').trim()) || null; } catch { return null; }
}

/** `tier` 1–3, or null to remove the ceiling. */
export function setUpTo(vendor, tier) {
  const f = upToFile(vendor);
  if (tier == null) { rmSync(f, { force: true }); return null; }
  if (![1, 2, 3].includes(tier)) throw new Error(`The ceiling must be a tier 1–3, got "${tier}"`);
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  writeFileSync(f, `${tier}\n`, { mode: 0o600 });
  return tier;
}

// ---------- out of credit ----------
const outFile = (vendor) => `${file(vendor)}.out.json`;

/** The vendor refused the key for lack of credit. `until`: the budget period's end, or null (until the key is reset). */
export function markExhausted(vendor, until = null) {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  writeFileSync(outFile(vendor), `${JSON.stringify({ at: new Date().toISOString(), until })}\n`, { mode: 0o600 });
}

/** { at, until } while the key counts as out of credit, else null. */
export function getExhausted(vendor, at = new Date()) {
  try {
    const e = JSON.parse(readFileSync(outFile(vendor), 'utf8'));
    return e.until && Date.parse(e.until) <= at.getTime() ? null : { at: e.at, until: e.until ?? null };
  } catch { return null; }
}

export const clearExhausted = (vendor) => rmSync(outFile(vendor), { force: true });

/** When the stored key was written, as ISO; null without a key. */
export function keySetAt(vendor) {
  try { return statSync(file(vendor)).mtime.toISOString(); } catch { return null; }
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

/** Last 4 characters, for display (a Console sign-in by name). */
export const hint = (k) => (k === CONSOLE ? 'Console sign-in' : k ? `…${k.slice(-4)}` : null);

/** { claude: '…abcd' | null, … } */
export const keyHints = () => Object.fromEntries(Object.keys(KEY_ENV).map(v => [v, hint(getKey(v))]));

/** Extra container env for a worker of `vendor`: the key, and Codex's separate home. */
export function workerKeyEnv(vendor, key = getKey(vendor)) {
  if (!key || isConsole(vendor, key)) return {}; // a Console sign-in is mounted (`workerKeyMounts`), not passed
  const env = { [KEY_ENV[vendor]]: key };
  if (vendor === 'codex') env.CODEX_HOME = '/home/worker/.vendor/codex-key';
  return env;
}
