import test from 'node:test';
import assert from 'node:assert/strict';
import { restartBroker } from '../src/broker-control.mjs';

test('broker restart when not running just starts', async () => {
  const events = [];
  const result = await restartBroker({
    readInfo: () => null,
    stop: async () => events.push('stop'),
    start: async () => { events.push('start'); return { pid: 7, port: 4321 }; },
  });
  assert.equal(result, 'broker 7 on 127.0.0.1:4321');
  assert.deepEqual(events, ['start']);
});

test('broker restart stops the running broker before starting', async () => {
  const events = [];
  let running = true;
  const result = await restartBroker({
    readInfo: () => running ? { pid: 1, port: 1234 } : null,
    isHealthy: async () => running,
    stop: async () => { events.push('stop'); running = false; },
    start: async () => { events.push('start'); return { pid: 2, port: 1234 }; },
    wait: async () => {},
  });
  assert.equal(result, 'broker 2 on 127.0.0.1:1234');
  assert.deepEqual(events, ['stop', 'start']);
});

test('broker restart timeout errors without starting a second broker', async () => {
  const events = [];
  await assert.rejects(restartBroker({
    readInfo: () => ({ pid: 1, port: 1234 }),
    isHealthy: async () => true,
    stop: async () => events.push('stop'),
    start: async () => { events.push('start'); return { pid: 2, port: 1234 }; },
    wait: async () => {},
    timeoutMs: 1,
  }), /did not stop.*refusing to start/);
  assert.deepEqual(events, ['stop']);
});
