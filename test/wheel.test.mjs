import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import { imageFor } from '../src/docker.mjs';
import * as keyStore from '../src/keys.mjs';
import { loadModels } from '../src/models.mjs';
import { wheel, startFailure, starting, tickWheels } from '../web/dashboard/wheel.js';

const settle = () => new Promise(r => setTimeout(r, 30));
const gh = { gitAuthEnv: async () => ({}), prFind: async () => null };

/** A satellite core, so every change to an agent is also emitted (as `state` events) in order. */
async function setup({ build = false, fail = null } = {}) {
  const db = openDb(':memory:');
  const sent = [];
  const host = {
    workRoot: '/hl/work',
    async run() { return { stdout: '' }; }, async hostGit() { return 'main'; },
    async startWorker({ onStep, vendor }) {
      for (const s of [...(build ? ['building worker image'] : []), 'starting container', 'preparing CodeGraph', `launching ${vendor} CLI`, 'sending brief']) {
        onStep(s);
        if (s === fail) throw new Error('no space left on device');
      }
    },
    async stopWorker() {}, async tmuxAlive() { return true; }, async tmuxType() {}, async tmuxCapture() { return ''; }, attachArgv: () => [],
  };
  const core = createCore({ db, host, github: gh, keys: { ...keyStore, getKey: () => null, getBudget: () => null }, notify: () => true,
    models: () => loadModels(join(tmpdir(), 'none.json')), workerUrl: 'http://w', publicUrl: 'http://p', runnerToken: 'RUN',
    satellite: { queue: (id, kind, text) => { if (kind === 'state') sent.push(JSON.parse(text)); } } });
  await core.call('delegator.start', { repo: 'gitgiant/demo' });
  const { id } = await core.call('spawn', { brief: 'task', vendor: 'claude', mode: 'cheapest' });
  await settle();
  return { row: db.prepare('SELECT * FROM agents WHERE id = ?').get(id), sent, steps: sent.map(e => e.step).filter(Boolean) };
}

test('a spawn records and emits its steps in order, and clears them once working', async () => {
  const { row, sent, steps } = await setup();
  assert.deepEqual(steps, ['cloning', 'starting container', 'preparing CodeGraph', 'launching claude CLI', 'sending brief']);
  let seen = {}; // each event carries only what changed
  for (const e of sent) { seen = { ...seen, ...e }; if (seen.step) assert.ok(seen.step_at, `${seen.step} has a start time`); }
  assert.deepEqual([row.state, row.step, row.step_at, row.step_error], ['working', null, null, null]);
});

test('the image-build step appears when the host builds', async () => {
  const { steps } = await setup({ build: true });
  assert.deepEqual(steps.slice(0, 3), ['cloning', 'building worker image', 'starting container']);
});

test('a failed start keeps the failing step and a short error', async () => {
  const { row } = await setup({ fail: 'preparing CodeGraph' });
  assert.deepEqual([row.state, row.step], ['failed', 'preparing CodeGraph']);
  assert.match(row.step_error, /no space left/);
  assert.match(row.report, /spawn failed/);
});

test('an image is announced as building only when it is built, also to a caller waiting for it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-wheel-'));
  try {
    writeFileSync(join(dir, 'hauptling.Dockerfile'), `ARG BASE\nFROM \${BASE}\n# ${dir}\n`);
    let built = false, finish;
    const dk = async (args) => {
      if (args[0] === 'image') { if (!built) throw new Error('No such image'); return {}; }
      await new Promise(r => { finish = r; });
      built = true;
      return {};
    };
    const calls = [];
    const make = (name) => imageFor(dir, { dk, baseImage: async () => 'base', onBuild: () => calls.push(name) });
    const first = make('first');
    await settle();
    const second = make('second');
    await settle();
    finish();
    await Promise.all([first, second]);
    await make('third');
    assert.deepEqual(calls, ['first', 'second']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const h = (tag, props = {}, ...kids) => ({ tag, ...props, kids: kids.flat().filter(Boolean) });
const at = '2026-11-27T10:00:00.000Z';
const now = Date.parse(at) + 42_500;

test('the wheel shows for starting agents only', () => {
  const el = wheel(h, { state: 'spawning', step: 'building worker image', step_at: at }, { now });
  assert.equal(el.class, 'wheel');
  assert.equal(el.kids[0].class, 'spinner');
  assert.equal(el.kids[1].text, 'building worker image · 42 s');
  assert.equal(wheel(h, { state: 'restarting' }, { now }).kids[1].text, 'starting');
  for (const a of [{ state: 'working' }, { state: 'queued', unpark: 'mail' }, { state: 'failed' }, { state: 'spawning', host_state: 'offline' }]) {
    assert.equal(wheel(h, a), null);
    assert.equal(starting(a), false);
  }
});

test('a failed start shows the step and error instead of the wheel', () => {
  const a = { state: 'failed', step: 'cloning', step_error: 'repository not found' };
  assert.equal(startFailure(h, a).text, '✕ failed while cloning: repository not found');
  assert.equal(startFailure(h, { ...a, state: 'working' }), null);
});

test('ticking advances the seconds', () => {
  const el = { dataset: { step: 'cloning', since: at } };
  tickWheels({ querySelectorAll: () => [el] }, now);
  assert.equal(el.textContent, 'cloning · 42 s');
});
