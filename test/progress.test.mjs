import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { progressTracker } from '../src/runner.mjs';
import { testProgress } from '../web/dashboard/progress.js';

test('progressTracker: counts result lines across chunks, strips colour, resets per step, writes progress.json', () => {
  const out = mkdtempSync(join(tmpdir(), 'hl-prog-'));
  let t = 0;
  const seen = [];
  const p = progressTracker(out, { onProgress: (x) => seen.push(x), every: 1000, now: () => t });
  p.step('install');
  p.take('added 300 packages\n');
  p.step('tests');
  assert.equal(p.current.results, 0, 'a new step starts from 0');
  p.take('\x1b[32mok\x1b[0m   claude-bo');
  p.take('ids\n       cost 1.48 ms\nFAIL agy-x\n✔ unit one (2ms)\nnot ok 4 - thing\n       artifacts: C:\\out\n');
  assert.equal(p.current.results, 4);
  assert.equal(p.current.line, 'not ok 4 - thing', 'once results come, the line is the latest result');
  assert.equal(seen.length, 2, 'updates between steps are throttled');
  t = 5000;
  p.take('\n');
  assert.equal(JSON.parse(readFileSync(join(out, 'progress.json'), 'utf8')).results, 4);
});

test('testProgress: time against the typical run, capped; no typical run means no percentage', () => {
  const now = Date.parse('2026-01-01T00:02:00Z');
  const t = { claimed_at: '2026-01-01T00:00:00Z', expect_s: 240, progress: { step: 'tests', line: 'ok   a', results: 3 } };
  const p = testProgress(t, now);
  assert.equal(p.pct, 0.5);
  assert.equal(p.label, '2:00 / ~4:00 · 3 done');
  assert.match(p.tip, /testing: ok {3}a/);
  assert.equal(p.over, false);
  const late = testProgress({ ...t, expect_s: 60 }, now);
  assert.equal(late.pct, 0.97);
  assert.equal(late.over, true);
  const fresh = testProgress({ claimed_at: t.claimed_at, expect_s: null, progress: null }, now);
  assert.equal(fresh.pct, null);
  assert.equal(fresh.label, '2:00');
});
