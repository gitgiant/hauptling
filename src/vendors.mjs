import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/*
 * Worker-side vendor setup, run inside the task container right before its TUI starts
 * (`hauptling prepare <vendor> /work`). User-level only: target repos are never touched.
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

export function prepare(vendor, dir, home = homedir(), { env = process.env, run = spawnSync } = {}) {
  if (vendor === 'claude') {
    // Containers set CLAUDE_CONFIG_DIR (the slot's credentials dir); .claude.json then lives inside it.
    const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
    const settingsPath = join(configDir, 'settings.json');
    const s = readJson(settingsPath);
    s.hooks ||= {};
    for (const e of HOOK_EVENTS.claude) {
      s.hooks[e] = (s.hooks[e] || []).filter(h => !ours(h));
      s.hooks[e].push({ hooks: [{ type: 'command', command: cmd('claude', e), timeout: 10 }] });
    }
    // Usage (context %, cost, 5h/weekly limits) reaches the broker through the status line; no model tokens.
    s.statusLine = { type: 'command', command: 'hauptling usage claude' };
    // Bare worker (token economy): plugins the slot picked up stay installed but off. MCP: --strict-mcp-config in models.json.
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
    const hooksPath = join(codexHome, 'hooks.json');
    const h = readJson(hooksPath);
    h.hooks ||= {};
    for (const e of HOOK_EVENTS.codex) {
      h.hooks[e] = (h.hooks[e] || []).filter(x => !ours(x));
      h.hooks[e].push({ hooks: [{ type: 'command', command: cmd('codex', e), timeout: 10 }] });
    }
    writeJson(hooksPath, h);
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
