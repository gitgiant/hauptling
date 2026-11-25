import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HAUPTLING_HOME = mkdtempSync(join(tmpdir(), 'hl-egress-'));
const { ensureNetwork } = await import('../src/docker.mjs');

/** Fake docker: a proxy on `image`, optional running workers; records what ran. */
function fakeDocker({ proxyImage = 'old', workers = '' } = {}) {
  const calls = [];
  let proxy = proxyImage ? `true ${proxyImage}` : '';
  const dk = async (args) => {
    calls.push(args.slice(0, 2).join(' '));
    await new Promise(r => setTimeout(r, 5));
    if (args[0] === 'network') return { stdout: '' };
    if (args[0] === 'inspect') { if (!proxy) throw new Error('no such container'); return { stdout: proxy }; }
    if (args[0] === 'ps') return { stdout: args.includes('label=hauptling.agent') ? workers : '' };
    if (args[0] === 'rm') { proxy = ''; return { stdout: '' }; }
    if (args[0] === 'run') { if (proxy) throw new Error('Conflict. The container name "/hauptling-egress" is already in use'); proxy = `true ${args[args.indexOf('hauptling') - 1]}`; return { stdout: 'id' }; }
    return { stdout: '' };
  };
  return { dk, calls, runs: () => calls.filter(c => c.startsWith('run')).length };
}
const opts = (f, extra = {}) => ({ dk: f.dk, baseImage: async () => 'new', ...extra });

test('egress: concurrent callers share one recreate (no name conflict)', async () => {
  const f = fakeDocker();
  const rs = await Promise.all([ensureNetwork(opts(f)), ensureNetwork(opts(f)), ensureNetwork(opts(f))]);
  assert.equal(f.runs(), 1);
  assert.deepEqual(rs.map(r => r.proxy), ['started', 'started', 'started']);
  assert.equal((await ensureNetwork(opts(f))).proxy, 'current');
});

test('egress: an older proxy is kept while workers use it; replaced when idle or forced', async () => {
  const busy = fakeDocker({ workers: 'abc123\n' });
  assert.equal((await ensureNetwork(opts(busy))).proxy, 'kept');
  assert.equal(busy.runs(), 0);
  assert.ok(!busy.calls.includes('rm -f'), 'running workers keep their network');
  assert.equal((await ensureNetwork(opts(busy, { force: true }))).proxy, 'started', 'setup forces the update');
  const idle = fakeDocker();
  assert.equal((await ensureNetwork(opts(idle))).proxy, 'started');
});

test('egress: losing a race to another process is fine when its proxy runs our image', async () => {
  const f = fakeDocker({ proxyImage: '' });
  const dk = async (args) => {
    if (args[0] === 'run') { await f.dk(['run', '-d', '--name', 'hauptling-egress', 'new', 'hauptling']); throw new Error('Conflict'); }
    return f.dk(args);
  };
  assert.equal((await ensureNetwork({ dk, baseImage: async () => 'new' })).proxy, 'current');
});
