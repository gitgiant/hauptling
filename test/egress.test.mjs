import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, unwatchFile, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { request } from 'node:http';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HAUPTLING_HOME = mkdtempSync(join(tmpdir(), 'hl-egress-'));
const { ensureNetwork } = await import('../src/docker.mjs');
const { runEgress } = await import('../src/egress.mjs');

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

/** The proxy on free localhost ports, allowing 127.0.0.1, relaying to an upstream that resets on "reset" and echoes the rest. */
async function proxy(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hl-proxy-'));
  const allow = join(dir, 'allow.txt'), log = join(dir, 'egress.log');
  writeFileSync(allow, '127.0.0.1\n');
  const upstream = createServer((s) => {
    s.on('error', () => {});
    s.on('data', (d) => {
      if (String(d).includes('midbody')) s.write('HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\npart', () => setTimeout(() => s.resetAndDestroy(), 20));
      else if (String(d).includes('reset')) s.resetAndDestroy();
      else s.write(d);
    });
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const up = upstream.address().port;
  const { server, relayServer } = runEgress({ allow, log, relay: `127.0.0.1:${up}`, port: 0, relayPort: 0 });
  await Promise.all([once(server, 'listening'), once(relayServer, 'listening')]);
  t.mock.method(console, 'error', () => {});
  const open = [];
  const dial = async (port = server.address().port) => {
    const s = connect(port, '127.0.0.1');
    open.push(s);
    s.on('error', () => {});
    await once(s, 'connect');
    return s;
  };
  const tunnel = async (target = `127.0.0.1:${up}`) => {
    const s = await dial();
    s.write(`CONNECT ${target} HTTP/1.1\r\n\r\n`);
    const [d] = await once(s, 'data');
    return { s, status: String(d).split('\r\n')[0] };
  };
  /** The next CONNECT still works, end to end. */
  const serving = async () => {
    const { s, status } = await tunnel();
    assert.match(status, /200/);
    s.write('ping');
    assert.equal(String((await once(s, 'data'))[0]), 'ping');
    s.destroy();
  };
  t.after(() => {
    unwatchFile(allow);
    for (const s of open) s.destroy();
    for (const s of [server, relayServer, upstream]) s.close();
    server.closeAllConnections();
  });
  const logged = () => readFileSync(log, 'utf8');
  return { server, relayServer, up, dial, tunnel, serving, logged };
}
const closed = (s) => (s.closed ? null : new Promise(r => s.once('close', r)));
const pause = () => new Promise(r => setTimeout(r, 50));

test('proxy: an upstream that resets mid-tunnel ends that tunnel only', async (t) => {
  const p = await proxy(t);
  const { s } = await p.tunnel();
  s.write('reset');
  await closed(s);
  await p.serving();
  assert.match(p.logged(), /^\S+ ERROR 127\.0\.0\.1 ECONNRESET$/m);
});

test('proxy: a client that resets mid-tunnel, or when refused, leaves it serving', async (t) => {
  const p = await proxy(t);
  const { s } = await p.tunnel();
  s.resetAndDestroy();
  await pause();
  await p.serving();
  for (const target of ['blocked.example:443', '127.0.0.1:99999', '127.0.0.1:1']) {
    const c = await p.dial();
    c.write(`CONNECT ${target} HTTP/1.1\r\n\r\n`, () => setImmediate(() => c.resetAndDestroy()));
    await pause();
  }
  const refused = await p.dial(); // reset after the 403 arrived
  refused.allowHalfOpen = true;
  refused.write('CONNECT blocked.example:443 HTTP/1.1\r\n\r\n');
  await once(refused, 'data');
  refused.resetAndDestroy();
  await pause();
  await p.serving();
});

test('proxy: resets and garbage on the HTTP path and the relay leave it serving', async (t) => {
  const p = await proxy(t);
  const get = (path) => new Promise((resolve) => {
    const req = request({ port: p.server.address().port, host: '127.0.0.1', path: `http://127.0.0.1:${p.up}/${path}`, agent: false }, (res) => {
      res.on('error', () => {});
      res.resume();
      res.on('close', () => resolve({ status: res.statusCode, complete: res.complete }));
    });
    req.on('error', (e) => resolve({ error: e.code }));
    req.end();
  });
  assert.equal((await get('reset')).status, 502);
  assert.deepEqual(await get('midbody'), { status: 200, complete: false });

  const half = await p.dial(); // client resets with the request still being sent
  half.write(`POST http://127.0.0.1:${p.up}/x HTTP/1.1\r\nhost: x\r\ncontent-length: 100\r\n\r\nabc`, () => setImmediate(() => half.resetAndDestroy()));
  await pause();
  const junk = await p.dial();
  junk.resume();
  junk.write('not http\r\n\r\n');
  await closed(junk);

  const relayed = await p.dial(p.relayServer.address().port);
  relayed.write('reset');
  await closed(relayed);
  const dropped = await p.dial(p.relayServer.address().port);
  dropped.resetAndDestroy();
  await pause();
  await p.serving();
  assert.match(p.logged(), /ERROR relay ECONNRESET/);
});
