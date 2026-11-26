import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageFor } from '../src/docker.mjs';

const checkout = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-img-'));
  writeFileSync(join(dir, 'hauptling.Dockerfile'), 'ARG BASE\nFROM ${BASE}\n');
  return dir;
};

/** Fake docker: a build takes a moment; `fail` names checkouts whose build fails. */
function fakeDocker(fail = []) {
  const images = new Set();
  const builds = [];
  let active = 0;
  let peak = 0;
  const dk = async (args) => {
    if (args[0] === 'image') { if (!images.has(args[2])) throw new Error('No such image'); return {}; }
    const dir = args.at(-1);
    builds.push(dir);
    peak = Math.max(peak, ++active);
    await new Promise(r => setTimeout(r, 10));
    active--;
    if (fail.includes(dir)) throw new Error('build failed');
    images.add(args[args.indexOf('-t') + 1]);
    return {};
  };
  return { opts: { dk, baseImage: async () => 'base:1' }, builds, peak: () => peak };
}

test('concurrent jobs needing one repo image share a single build', async () => {
  const d = fakeDocker();
  const tags = await Promise.all([checkout(), checkout(), checkout()].map(dir => imageFor(dir, d.opts)));
  assert.equal(new Set(tags).size, 1);
  assert.equal(d.builds.length, 1);
});

test('a failed image build fails only its own job; the waiters build from their checkouts, one at a time', async () => {
  const [a, b, c] = [checkout(), checkout(), checkout()];
  const d = fakeDocker([a]);
  const results = await Promise.allSettled([a, b, c].map(dir => imageFor(dir, d.opts)));
  assert.deepEqual(results.map(r => r.status), ['rejected', 'fulfilled', 'fulfilled']);
  assert.deepEqual(d.builds, [a, b]);
  assert.equal(d.peak(), 1);
});
