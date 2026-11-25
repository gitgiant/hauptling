import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HAUPTLING_HOME = mkdtempSync(join(tmpdir(), 'hl-docker-'));
const { workerRunArgs, VENDOR_DIRS } = await import('../src/docker.mjs');

const mounts = (args) => args.flatMap((a, i) => (a === '-v' ? [args[i + 1]] : []));
const slots = join(process.env.HAUPTLING_HOME, 'slots');
const run = (id, vendor, slot = 'hl-w2') => workerRunArgs({ slot, id, dir: `/hl/work/${id}`, vendor, mcpFile: `/hl/mcp/${id}.json`, image: 'img', limits: { memory: '1g', cpus: 1 } });

test('a worker container mounts only its own vendor dir(s) from the slot, never the whole slot', () => {
  const want = {
    claude: [`${slots}/hl-w2/claude:/home/worker/.vendor/claude`],
    codex: [`${slots}/hl-w2/codex:/home/worker/.vendor/codex`, `${slots}/hl-w2/codex-key:/home/worker/.vendor/codex-key`],
    agy: [`${slots}/hl-w2/gemini:/home/worker/.vendor/gemini`],
  };
  for (const vendor of Object.keys(VENDOR_DIRS)) {
    const id = `${vendor}_m_abcde`;
    const m = mounts(run(id, vendor));
    assert.deepEqual(m.filter(x => x.startsWith(slots)), want[vendor], vendor);
    assert.ok(!m.some(x => x.endsWith(':/home/worker/.vendor')), `${vendor} mounts the whole slot`);
    assert.ok(m.includes(`/hl/work/${id}:/work`), `${vendor} has its own clone at /work`);
    assert.ok(!m.some(x => /:\/home\/worker(:|$)/.test(x)), `${vendor} shares a home dir`);
  }
  assert.ok(existsSync(join(slots, 'hl-w2', 'codex-key')), 'slot dirs are created');
  assert.throws(() => run('x', 'gpt'), /Unknown vendor/);
});

test('workers of two vendors on one slot: own container, own clone, disjoint credential mounts', () => {
  const a = run('claude_m_11111', 'claude');
  const b = run('codex_m_22222', 'codex');
  assert.notEqual(a[a.indexOf('--name') + 1], b[b.indexOf('--name') + 1]);
  const [ma, mb] = [mounts(a), mounts(b)];
  const hostSide = (m) => m.map(x => x.split(':')[0]);
  assert.deepEqual(hostSide(ma).filter(x => hostSide(mb).includes(x)), [], 'no host dir mounted into both');
  assert.ok(a.includes('hauptling.vendor=claude') && b.includes('hauptling.vendor=codex'));
});
