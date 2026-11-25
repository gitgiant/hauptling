import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { detect } from './detect.mjs';

/*
 * Worker-side vendor setup, run inside the task container right before its TUI starts
 * (`hauptling prepare <vendor> /work`). User-level only: target repos are never touched.
 * Claude and Codex hooks are managed files in the image instead (managedFiles()).
 * Hook formats: Claude $CLAUDE_CONFIG_DIR/settings.json, Codex $CODEX_HOME/hooks.json,
 * agy ~/.gemini/config/hooks.json (agy has no UserPromptSubmit; PreInvocation runs before each model call).
 */

export const HOOK_EVENTS = {
  claude: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'],
  codex: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'],
  agy: ['SessionStart', 'PreInvocation', 'PostToolUse', 'Stop'],
};

const readJson = (p, d = {}) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8') || '{}') : d);
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
const cmd = (vendor, event) => `hauptling hook ${vendor} ${event}`;
const ours = (h) => JSON.stringify(h).includes('hauptling hook');

/**
 * Files baked into the worker image (as root) so workers run only Hauptling's hooks: the repo's own
 * `.claude/settings.json` and `.codex/hooks.json` hooks are ignored (they'd run the repo's own tooling,
 * often with host paths). Claude: managed settings with allowManagedHooksOnly; Codex: system-layer
 * hooks (managed, so no trust review) plus allow_managed_hooks_only in requirements.toml.
 * @returns {Record<string, string>} absolute path → content
 */
export function managedFiles() {
  const hooks = (vendor) => Object.fromEntries(HOOK_EVENTS[vendor].map(e => [e, [{ hooks: [{ type: 'command', command: cmd(vendor, e), timeout: 10 }] }]]));
  const json = (v) => JSON.stringify(v, null, 2) + '\n';
  return {
    // Usage (context %, cost, 5h/weekly limits) reaches the broker through the status line; no model tokens.
    '/etc/claude-code/managed-settings.json': json({ allowManagedHooksOnly: true, hooks: hooks('claude'), statusLine: { type: 'command', command: 'hauptling usage claude' } }),
    '/etc/codex/hooks.json': json({ hooks: hooks('codex') }),
    '/etc/codex/requirements.toml': 'allow_managed_hooks_only = true\n',
  };
}

export function writeManagedFiles() {
  for (const [p, c] of Object.entries(managedFiles())) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }
}

export function prepare(vendor, dir, home = homedir(), { env = process.env, run = spawnSync } = {}) {
  if (vendor === 'claude') {
    // Containers set CLAUDE_CONFIG_DIR (the slot's credentials dir); .claude.json then lives inside it.
    const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
    const settingsPath = join(configDir, 'settings.json');
    const s = readJson(settingsPath);
    // Hooks and the status line are managed (baked into the image by managedFiles()); drop copies older versions wrote here.
    for (const e of Object.keys(s.hooks || {})) s.hooks[e] = s.hooks[e].filter(h => !ours(h));
    if (JSON.stringify(s.statusLine || '').includes('hauptling usage')) delete s.statusLine;
    // Bare worker (token economy): plugins the slot picked up stay installed but off. MCP: managed-mcp.json (src/codegraph.mjs).
    if (s.enabledPlugins) s.enabledPlugins = Object.fromEntries(Object.keys(s.enabledPlugins).map(k => [k, false]));
    writeJson(settingsPath, s);
    // Skip the first-run folder trust dialog for this clone.
    const statePath = env.CLAUDE_CONFIG_DIR ? join(configDir, '.claude.json') : join(home, '.claude.json');
    const st = readJson(statePath);
    st.projects ||= {};
    st.projects[dir] = { ...st.projects[dir], hasTrustDialogAccepted: true };
    if (env.ANTHROPIC_API_KEY) {
      // API key mode (`hauptling key set claude`): pre-approve the key (the TUI asks once otherwise) and skip first-run onboarding.
      const tail = env.ANTHROPIC_API_KEY.slice(-20);
      const r = st.customApiKeyResponses || {};
      st.customApiKeyResponses = { approved: [...new Set([...(r.approved || []), tail])], rejected: (r.rejected || []).filter(x => x !== tail) };
      st.hasCompletedOnboarding = true;
    }
    writeJson(statePath, st);
  } else if (vendor === 'codex') {
    const codexHome = env.CODEX_HOME || join(home, '.codex');
    if (env.OPENAI_API_KEY) {
      // API key mode: CODEX_HOME is the slot's separate codex-key dir; store the key there once (or when it changed).
      mkdirSync(codexHome, { recursive: true });
      const auth = readJson(join(codexHome, 'auth.json'));
      if (auth.OPENAI_API_KEY !== env.OPENAI_API_KEY) {
        const r = run('codex', ['login', '--with-api-key'], { input: env.OPENAI_API_KEY, env: { ...env, CODEX_HOME: codexHome }, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`codex login --with-api-key failed: ${(r.stderr || r.stdout || '').trim().slice(-300)}`);
      }
    }
    // Hooks are managed (/etc/codex, see managedFiles()); drop copies older versions wrote here.
    const hooksPath = join(codexHome, 'hooks.json');
    if (existsSync(hooksPath)) {
      const h = readJson(hooksPath);
      for (const e of Object.keys(h.hooks || {})) h.hooks[e] = h.hooks[e].filter(x => !ours(x));
      writeJson(hooksPath, h);
    }
    const configPath = join(codexHome, 'config.toml');
    const header = `[projects."${dir}"]`;
    const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
    if (!config.includes(header)) appendFileSync(configPath, `\n${header}\ntrust_level = "trusted"\n`);
  } else if (vendor === 'agy') {
    const hooksPath = join(home, '.gemini', 'config', 'hooks.json');
    const h = readJson(hooksPath);
    for (const e of HOOK_EVENTS.agy) {
      const handler = { type: 'command', command: cmd('agy', e), timeout: 10 };
      h[`hauptling-${e}`] = { [e]: e === 'PostToolUse' ? [{ matcher: '.*', hooks: [handler] }] : [handler] };
    }
    writeJson(hooksPath, h);
    const settingsPath = join(home, '.gemini', 'antigravity-cli', 'settings.json');
    const s = readJson(settingsPath);
    s.trustedWorkspaces = [...new Set([...(s.trustedWorkspaces || []), dir])];
    // Unattended workers must be able to report and request tests; nothing else is pre-approved.
    s.permissions ||= {};
    s.permissions.allow = [...new Set([...(s.permissions.allow || []), 'command(hauptling)'])];
    s.statusLine = { type: 'command', command: 'hauptling usage agy' };
    writeJson(settingsPath, s);
  } else throw new Error(`Unknown vendor ${vendor}`);
}

/** Seconds a clone's dependency install may take before it is killed. */
export const INSTALL_TIMEOUT_S = 900;

/**
 * Installs the clone's dependencies (hauptling.json / detect.mjs "install") before the CLI starts, inside the
 * worker container, so through the egress proxy. Output goes to <dir>/.hauptling/install.log (excluded from git).
 * Never throws: a failure is put at the top of the brief so the worker knows to retry it itself.
 * @returns {{ status: 'none' | 'ok' | 'failed', cmd?: string }}
 */
export function installDeps(dir, { env = process.env, run = spawnSync, timeoutS = INSTALL_TIMEOUT_S } = {}) {
  let argv;
  try { argv = detect(dir).install; } catch (e) { note(dir, `Dependency detection failed (${e.message}); install dependencies yourself.`); return { status: 'failed' }; }
  if (!Array.isArray(argv) || !argv.length) return { status: 'none' };
  const cmd = argv.join(' ');
  const logPath = join(dir, '.hauptling', 'install.log');
  mkdirSync(dirname(logPath), { recursive: true });
  const r = run(argv[0], argv.slice(1), { cwd: dir, env: { ...env, CI: '1' }, encoding: 'utf8', timeout: timeoutS * 1000, killSignal: 'SIGKILL', maxBuffer: 64 << 20 });
  const out = `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`;
  writeFileSync(logPath, `$ ${cmd}\n${out}\n[exit ${r.status ?? r.signal}]\n`);
  if (r.status === 0) return { status: 'ok', cmd };
  const why = r.error?.code === 'ETIMEDOUT' || (r.signal && r.status === null) ? `timed out after ${timeoutS} s` : `exit ${r.status ?? r.signal}`;
  const tail = out.trim().split('\n').slice(-5).join(' | ').slice(-600);
  note(dir, `Dependency install failed (${why}): ${tail || 'no output'}. Run \`${cmd}\` yourself (full log: .hauptling/install.log).`);
  return { status: 'failed', cmd };
}

/** Puts a line at the top of the clone's brief (written by the broker before the container starts). */
function note(dir, line) {
  const p = join(dir, '.hauptling', 'brief.md');
  const brief = existsSync(p) ? readFileSync(p, 'utf8') : '';
  writeFileSync(p, `> **${line}**\n\n${brief}`);
}

/** Normalizes a vendor's hook stdin. */
export function hookInput(vendor, raw) {
  if (vendor === 'agy') return { sessionId: raw.conversationId, model: raw.modelName, cwd: raw.workspacePaths?.[0], subagent: false };
  return { sessionId: raw.session_id, model: raw.model, cwd: raw.cwd, subagent: Boolean(raw.agent_id || raw.subagent) };
}

/** Vendor-specific hook stdout for injected context (while working) or a stop block (mail arrived at Stop). */
export function hookOutput(vendor, event, { context, block }) {
  if (block) {
    if (event !== 'Stop') return hookOutput(vendor, event, { context: block });
    return vendor === 'agy' ? { decision: 'continue', reason: block } : { decision: 'block', reason: block };
  }
  if (!context) return null;
  if (vendor === 'agy') {
    if (event === 'SessionStart') return { injectSteps: [{ systemMessage: { systemMessage: context } }] };
    if (event === 'PreInvocation') return { injectSteps: [{ ephemeralMessage: context }] };
    return null;
  }
  if (event === 'Stop') return null;
  return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}

/** Events at which a vendor can receive injected text (mail is only claimed there). */
export function canInject(vendor, event) {
  if (event === 'Stop') return true;
  if (vendor === 'agy') return event === 'SessionStart' || event === 'PreInvocation';
  return true;
}
