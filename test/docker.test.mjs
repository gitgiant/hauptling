import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HAUPTLING_HOME = mkdtempSync(join(tmpdir(), 'hl-docker-'));
// A sign-in per slot here (the default is one shared sign-in; its own test is below).
writeFileSync(join(process.env.HAUPTLING_HOME, 'config.json'), '{"signins":3}');
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

test('shared sign-ins: one by default, so every slot mounts hl-w1; more spread the slots over them', async () => {
  const { signins, signinSlot, setSignins, vendorMounts, signOutSlot, CREDS, codexRollout } = await import('../src/docker.mjs');
  const { mkdirSync, readFileSync, utimesSync } = await import('node:fs');
  const cfgPath = join(process.env.HAUPTLING_HOME, 'config.json');
  const saved = readFileSync(cfgPath, 'utf8');
  try {
    writeFileSync(cfgPath, '{"maxWorkers":4}');
    assert.equal(signins('claude'), 1);
    assert.deepEqual(['hl-w1', 'hl-w2', 'hl-w3'].map(s => signinSlot(s, 'claude')), ['hl-w1', 'hl-w1', 'hl-w1']);
    assert.deepEqual(vendorMounts('hl-w3', 'agy'), ['-v', `${slots}/hl-w1/gemini:/home/worker/.vendor/gemini`]);
    setSignins('agy', 2);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')), { maxWorkers: 4, signins: { claude: 1, codex: 1, agy: 2 } }, 'the rest of the config is kept');
    assert.deepEqual(['hl-w1', 'hl-w2', 'hl-w3', 'hl-w4'].map(s => signinSlot(s, 'agy')), ['hl-w1', 'hl-w2', 'hl-w1', 'hl-w2']);
    assert.equal(signinSlot('hl-w2', 'claude'), 'hl-w1', 'other vendors keep theirs');
    assert.throws(() => setSignins('agy', 0), /whole number/);
    // Signing out a slot that shares a sign-in removes the shared credential.
    mkdirSync(join(slots, 'hl-w1', 'claude'), { recursive: true });
    writeFileSync(join(slots, 'hl-w1', CREDS.claude), 'token');
    assert.equal(signOutSlot('hl-w3', 'claude'), true);
    assert.ok(!existsSync(join(slots, 'hl-w1', CREDS.claude)));
    // Workers sharing a Codex dir: each reads its own session's log, not the newest.
    const day = join(slots, 'hl-w1', 'codex', 'sessions', '2026', '11', '27');
    mkdirSync(day, { recursive: true });
    const line = (n) => JSON.stringify({ payload: { type: 'token_count', info: { total_token_usage: { input_tokens: n } } } }) + '\n';
    writeFileSync(join(day, 'rollout-2026-11-27T10-00-00-aaaa1111.jsonl'), line(1));
    writeFileSync(join(day, 'rollout-2026-11-27T10-00-01-bbbb2222.jsonl'), line(2));
    utimesSync(join(day, 'rollout-2026-11-27T10-00-01-bbbb2222.jsonl'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const root = [join(slots, 'hl-w1', 'codex', 'sessions')];
    assert.equal((await codexRollout(root, null)).info.total_token_usage.input_tokens, 2, 'no session id: the newest log');
    assert.equal((await codexRollout(root, null, 'aaaa1111')).info.total_token_usage.input_tokens, 1);
    assert.equal(await codexRollout(root, null, 'cccc3333'), null);
  } finally { writeFileSync(cfgPath, saved); }
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

test('host info debug probes: Docker sizes, log tails without secrets, the egress log, .wslconfig memory', async () => {
  const { sizeMB, logTail, tailText, egressLog, wslConfigMemMB } = await import('../src/docker.mjs');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  assert.deepEqual(['12.21MiB', ' 7.719GiB', '4.49GB (99%)', '0B', '281.1MB', 'N/A'].map(sizeMB), [12.2, 7904.3, 4282, 0, 268.1, null]);
  const tail = logTail(['one', 'gh auth: token=ghs_abcdefghijklmnop1234 ok', 'key sk-ant-api03-abcdefgh used', `long ${'x'.repeat(500)}`].join('\n'), 3);
  assert.deepEqual(tail.slice(0, 2), ['gh auth: token=[removed] ok', 'key [removed] used']);
  assert.equal(tail[2].length, 401, 'long lines are cut');
  const file = join(mkdtempSync(join(tmpdir(), 'hl-tail-')), 'x.log');
  writeFileSync(file, 'first line\nsecond\nthird\n');
  assert.equal(tailText(file, 10), 'third\n', 'a line cut by the window is dropped');
  assert.equal(tailText(file), 'first line\nsecond\nthird\n');
  assert.equal(tailText(join(file, 'missing')), '');
  const at = Date.parse('2026-11-27T12:00:00Z');
  const log = ['2026-11-27T09:00:00Z BLOCK a.com', '2026-11-27T10:00:00Z BLOCK b.com', '2026-11-27T10:30:00Z ERROR old.com ECONNRESET', '2026-11-27T11:00:00Z BLOCK a.com',
    '2026-11-27T11:30:00Z ERROR api.x.com ETIMEDOUT', ''].join('\n');
  assert.deepEqual(egressLog(log, at), { blocked: [{ host: 'a.com', n: 2, last: '2026-11-27T11:00:00Z' }, { host: 'b.com', n: 1, last: '2026-11-27T10:00:00Z' }], errors: 1, lastError: 'api.x.com ETIMEDOUT' });
  assert.equal(egressLog(log, at, 1).blocked.length, 1);
  assert.equal(wslConfigMemMB('[wsl2]\r\nvmIdleTimeout=-1\r\nmemory=10GB # more\r\n'), 10240);
  assert.equal(wslConfigMemMB('[wsl2]\nmemory = 8192MB'), 8192);
  assert.equal(wslConfigMemMB('[experimental]\nmemory=4GB\n[wsl2]\nprocessors=4'), null);
});

test('host info debug probes: container stats and Docker disk from docker\'s output; the egress proxy missing', async () => {
  const { dockerHost } = await import('../src/docker.mjs');
  const calls = [];
  const docker = async (args) => {
    calls.push(args[0]);
    if (args[0] === 'ps') return { stdout: 'hl-a\trunning\ta\t\t\nhauptling-test-t1\trunning\t\tt1\t\nhauptling-egress\trunning\t\t\tegress\nsomeone-elses\trunning\t\t\t\n' };
    if (args[0] === 'stats') { assert.deepEqual(args.slice(4), ['hl-a', 'hauptling-test-t1', 'hauptling-egress']); return { stdout: 'hl-a\t140.52%\t512MiB / 2.5GiB\t40\nhauptling-test-t1\t20.00%\t1.5GiB / 2.5GiB\t9\nhauptling-egress\t0.00%\t12MiB / 7.7GiB\t12\n' }; }
    if (args[0] === 'system') return { stdout: '{"Active":"1","Reclaimable":"4.49GB (99%)","Size":"4.491GB","TotalCount":"39","Type":"Images"}\n' };
    throw new Error('No such object');
  };
  const host = dockerHost({ docker });
  assert.deepEqual((await host.containerStats()).map(c => [c.name, c.kind, c.id, c.cores, c.memMB, c.limitMB]),
    [['hauptling-test-t1', 'test job', 't1', 0.2, 1536, 2560], ['hl-a', 'worker', 'a', 1.41, 512, 2560], ['hauptling-egress', 'egress proxy', null, 0, 12, 7884.8]]);
  await host.containerStats();
  assert.equal(calls.filter(c => c === 'stats').length, 1, 'a second reading within seconds reuses the first');
  assert.deepEqual(await host.dockerDisk(), [{ type: 'Images', count: 39, active: 1, sizeMB: 4283, reclaimMB: 4282 }]);
  const e = await host.egressState();
  assert.equal(e.running, false);
  assert.equal(e.missing, true);
});
