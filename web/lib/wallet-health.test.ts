import assert from 'node:assert/strict';
import { test } from 'node:test';

import { probeWalletRpc, watchSlowRequest } from './wallet-health.ts';

const never = () => new Promise<never>(() => {});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

void test('a wallet that returns a block number is healthy', async () => {
  const methods: string[] = [];
  const health = await probeWalletRpc(async ({ method }) => {
    methods.push(method);
    return '0x1a2b';
  });
  assert.equal(health, 'ok');
  // Not eth_chainId, which a wallet answers without its RPC.
  assert.deepEqual(methods, ['eth_blockNumber']);
});

void test('a wallet whose RPC never answers times out', async () => {
  const started = Date.now();
  assert.equal(await probeWalletRpc(never, 30), 'timeout');
  assert.ok(Date.now() - started < 1_000);
});

void test('a wallet whose RPC errors, or answers nonsense, is unhealthy', async () => {
  assert.equal(
    await probeWalletRpc(async () => {
      throw Object.assign(new Error('Internal JSON-RPC error.'), {
        code: -32603,
      });
    }),
    'error',
  );
  assert.equal(await probeWalletRpc(async () => null), 'error');
});

void test('a request that settles quickly is never reported slow', async () => {
  let checks = 0;
  const result = await watchSlowRequest(
    Promise.resolve('0xhash'),
    async () => (checks++, true),
    20,
  );
  await delay(60);
  assert.equal(result, '0xhash');
  assert.equal(checks, 0);
});

void test('a slow request is checked repeatedly while the wallet stays healthy', async () => {
  let checks = 0;
  let finish: (hash: string) => void = () => {};
  const watched = watchSlowRequest(
    new Promise<string>((resolve) => (finish = resolve)),
    async () => (checks++, true),
    20,
  );
  await delay(75);
  finish('0xlate');
  // The late answer still comes through: nothing was abandoned.
  assert.equal(await watched, '0xlate');
  const afterSettle = checks;
  assert.ok(afterSettle >= 2);
  await delay(60);
  assert.equal(checks, afterSettle);
});

void test('checks stop once one reports the wallet unreachable', async () => {
  let checks = 0;
  void watchSlowRequest(never(), async () => (checks++, false), 20);
  await delay(100);
  assert.equal(checks, 1);
});
