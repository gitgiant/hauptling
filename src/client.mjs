import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBrokerFile } from './brokerfile.mjs';
import { BROKER_PORT } from './util.mjs';

const BIN = fileURLToPath(new URL('../bin/hauptling.mjs', import.meta.url));

async function healthy(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

/** Host: make sure the broker runs (spawning it detached if needed) and return its address + admin token. */
export async function ensureBroker() {
  let info = readBrokerFile();
  if (info && await healthy(info.port)) return info;
  if (process.env.HAUPTLING_AGENT) throw new Error('Broker unreachable; workers do not start it (ask the user to check `hauptling broker status`)');
  const child = spawn(process.execPath, [BIN, 'broker', 'run'], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    info = readBrokerFile();
    if (info && info.pid === child.pid && await healthy(info.port)) return info;
  }
  throw new Error('Broker did not start; see ~/.hauptling/broker.log');
}

export async function endpoint() {
  if (process.env.HAUPTLING_BROKER && process.env.HAUPTLING_TOKEN) return { url: process.env.HAUPTLING_BROKER, token: process.env.HAUPTLING_TOKEN, worker: true };
  const info = await ensureBroker();
  return { url: `http://127.0.0.1:${info.port || BROKER_PORT}`, token: process.env.HAUPTLING_TOKEN || info.adminToken, worker: false };
}

export async function call(name, args = {}) {
  const { url, token } = await endpoint();
  let res;
  try {
    res = await fetch(`${url}/api/${name}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  } catch (e) {
    throw new Error(`Broker unreachable at ${url} (${e.cause?.code || e.message}). Check \`hauptling broker status\`.`);
  }
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
  return body.result;
}
