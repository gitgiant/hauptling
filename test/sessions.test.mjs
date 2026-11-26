import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionFiles, saveSession, restoreSession, dropSession } from '../src/sessions.mjs';

const SID = '0b3e7c1a-5d2f-4e6a-9c8b-112233445566';

/** Every regular file (and symlink) under dir, relative to it. */
function tree(dir, out = [], root = dir) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tree(p, out, root); else out.push(relative(root, p));
  }
  return out.sort();
}

/** A slot dir as `hauptling login` and a few worker runs leave it: credentials, settings, several sessions. */
function fakeSlot() {
  const s = mkdtempSync(join(tmpdir(), 'hl-slot-'));
  const put = (rel, text = 'x') => { mkdirSync(join(s, rel, '..'), { recursive: true }); writeFileSync(join(s, rel), text); };
  put('claude/.credentials.json', 'CLAUDE-SECRET');
  put('claude/.claude.json', '{"oauthAccount":{}}');
  put('claude/settings.json', '{}');
  put(`claude/projects/-work/${SID}.jsonl`, 'transcript');
  put(`claude/projects/-work/${SID}/subagents/agent-1.jsonl`, 'sub');
  put('claude/projects/-work/other-session.jsonl', 'not ours');
  put(`claude/todos/${SID}-agent.json`, 'todo'); // outside projects/: not a transcript
  symlinkSync(join(s, 'claude/.credentials.json'), join(s, `claude/projects/-work/${SID}-link.jsonl`));
  mkdirSync(join(s, 'claude/projects/-elsewhere'), { recursive: true });
  symlinkSync(join(s, 'claude/.credentials.json'), join(s, `claude/projects/-elsewhere/${SID}.jsonl`));
  put('codex/auth.json', 'CODEX-SECRET');
  put('codex/config.toml', 'model = "x"');
  put(`codex/sessions/2026/11/26/rollout-2026-11-26T10-00-00-${SID}.jsonl`, 'rollout');
  put('codex/sessions/2026/11/26/rollout-2026-11-26T09-00-00-aaaa-bbbb.jsonl', 'other');
  put('codex-key/auth.json', 'CODEX-KEY-SECRET');
  put('gemini/antigravity-cli/antigravity-oauth-token', 'AGY-SECRET');
  put(`gemini/antigravity-cli/conversations/${SID}.json`, 'agy');
  return s;
}

test('sessions: only the session transcript leaves the slot, never credentials or other files', () => {
  const slot = fakeSlot();
  const store = mkdtempSync(join(tmpdir(), 'hl-store-'));
  assert.deepEqual(saveSession({ slotRoot: slot, store, vendor: 'claude', sessionId: SID }), [
    `claude/projects/-work/${SID}.jsonl`,
    `claude/projects/-work/${SID}/subagents/agent-1.jsonl`,
  ]);
  assert.deepEqual(tree(store), [`files/claude/projects/-work/${SID}.jsonl`, `files/claude/projects/-work/${SID}/subagents/agent-1.jsonl`]);
  for (const f of tree(store)) assert.doesNotMatch(readFileSync(join(store, f), 'utf8'), /SECRET/);

  // Saving again replaces the copy; codex sessions are found by id anywhere under sessions/.
  assert.deepEqual(saveSession({ slotRoot: slot, store, vendor: 'codex', sessionId: SID }), [`codex/sessions/2026/11/26/rollout-2026-11-26T10-00-00-${SID}.jsonl`]);
  assert.deepEqual(tree(store), [`files/codex/sessions/2026/11/26/rollout-2026-11-26T10-00-00-${SID}.jsonl`]);

  // agy: nowhere known to resume from, so nothing (it unparks fresh).
  assert.deepEqual(sessionFiles(slot, 'agy', SID), []);
  // A session id can't walk out of the session roots.
  for (const bad of ['../.credentials', '..', '', null, 'a/b', '.credentials.json']) assert.deepEqual(sessionFiles(slot, 'claude', bad), []);
});

test('sessions: restore writes only into the vendor session root of the new slot; codex follows the billing', () => {
  const slot = fakeSlot();
  const store = mkdtempSync(join(tmpdir(), 'hl-store-'));
  saveSession({ slotRoot: slot, store, vendor: 'claude', sessionId: SID });
  // A stray file in the store (not something save writes) is not restored.
  mkdirSync(join(store, 'files', 'claude'), { recursive: true });
  writeFileSync(join(store, 'files', 'claude', '.credentials.json'), 'PLANTED');

  const next = mkdtempSync(join(tmpdir(), 'hl-slot2-'));
  mkdirSync(join(next, 'claude'), { recursive: true });
  writeFileSync(join(next, 'claude', '.credentials.json'), 'NEXT-SLOT-OWN');
  assert.deepEqual(restoreSession({ slotRoot: next, store, vendor: 'claude' }), [
    `claude/projects/-work/${SID}.jsonl`,
    `claude/projects/-work/${SID}/subagents/agent-1.jsonl`,
  ]);
  assert.equal(readFileSync(join(next, 'claude/.credentials.json'), 'utf8'), 'NEXT-SLOT-OWN');
  assert.equal(readFileSync(join(next, `claude/projects/-work/${SID}.jsonl`), 'utf8'), 'transcript');

  saveSession({ slotRoot: slot, store, vendor: 'codex', sessionId: SID });
  const keyed = mkdtempSync(join(tmpdir(), 'hl-slot3-'));
  assert.deepEqual(restoreSession({ slotRoot: keyed, store, vendor: 'codex', billing: 'api' }), [`codex-key/sessions/2026/11/26/rollout-2026-11-26T10-00-00-${SID}.jsonl`]);
  assert.deepEqual(tree(keyed), [`codex-key/sessions/2026/11/26/rollout-2026-11-26T10-00-00-${SID}.jsonl`]);

  dropSession(store);
  assert.equal(existsSync(store), false);
  assert.deepEqual(restoreSession({ slotRoot: keyed, store, vendor: 'codex' }), []);
});

test('sessions: the docker host keeps copies under ~/.hauptling/sessions/<agent>/', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hl-home-'));
  const old = process.env.HAUPTLING_HOME;
  process.env.HAUPTLING_HOME = home;
  try {
    const { dockerHost } = await import('../src/docker.mjs');
    const host = dockerHost();
    const slot = join(home, 'slots', 'hl-w1');
    mkdirSync(join(slot, 'claude/projects/-work'), { recursive: true });
    writeFileSync(join(slot, 'claude/.credentials.json'), 'SECRET');
    writeFileSync(join(slot, `claude/projects/-work/${SID}.jsonl`), 'transcript');
    assert.deepEqual(host.saveSession({ slot: 'hl-w1', vendor: 'claude', id: 'claude_x_1', sessionId: SID }), [`claude/projects/-work/${SID}.jsonl`]);
    assert.deepEqual(tree(join(home, 'sessions')), [`claude_x_1/files/claude/projects/-work/${SID}.jsonl`]);
    assert.deepEqual(host.restoreSession({ slot: 'hl-w2', vendor: 'claude', id: 'claude_x_1' }), [`claude/projects/-work/${SID}.jsonl`]);
    assert.equal(existsSync(join(home, 'slots/hl-w2/claude/.credentials.json')), false);
    host.dropSession('claude_x_1');
    assert.deepEqual(tree(join(home, 'sessions')), []);
  } finally {
    if (old === undefined) delete process.env.HAUPTLING_HOME; else process.env.HAUPTLING_HOME = old;
  }
});
