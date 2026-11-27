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
