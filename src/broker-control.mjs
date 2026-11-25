import { readBrokerFile } from './brokerfile.mjs';
import { ensureBroker } from './client.mjs';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function healthy(info) {
  if (!info) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch { return false; }
}

/** Stop a running broker, wait for it to exit, then start it. */
export async function restartBroker({ readInfo = readBrokerFile, isHealthy = healthy, stop = async info => {
  await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, {
    method: 'POST', headers: { authorization: `Bearer ${info.adminToken}` },
    signal: AbortSignal.timeout(1000),
  });
}, start = ensureBroker, wait = sleep, timeoutMs = 10_000 } = {}) {
  const info = readInfo();
  if (info && await isHealthy(info)) {
    await stop(info);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = readInfo();
      if (!current || !(await isHealthy(current))) break;
      await wait(Math.min(200, Math.max(1, deadline - Date.now())));
    }
    const current = readInfo();
    if (current && await isHealthy(current)) throw new Error(`Broker did not stop within ${timeoutMs} ms; refusing to start another broker`);
  }
  const started = await start();
  return `broker ${started.pid} on 127.0.0.1:${started.port}`;
}
