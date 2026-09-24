import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkWalletRpc,
  probeWalletRpc,
  WALLET_PROBE_TIMEOUT_MS,
  watchSlowRequest,
} from './wallet-health.ts';

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

const X_LAYER = 1952;

/**
 * A wallet stub: connected, unlocked and on X Layer unless told otherwise,
 * answering eth_blockNumber per `blockNumber` (one entry per call, the last
 * repeating). `null` never answers.
 */
function stubWallet({
  accounts = ['0xD95Bd9f3E641974515B53adE252AD43e7cB28059'],
  chainId = '0x7a0',
  blockNumber = [0],
}: {
  accounts?: string[];
  chainId?: string;
  blockNumber?: (number | null | Error)[];
} = {}) {
  const calls: string[] = [];
  let probes = 0;
  const request = async ({ method }: { method: string }) => {
    calls.push(method);
    if (method === 'eth_accounts') return accounts;
    if (method === 'eth_chainId') return chainId;
    const answer = blockNumber[Math.min(probes++, blockNumber.length - 1)];
    if (answer === null) return never();
    if (answer instanceof Error) throw answer;
    await delay(answer);
    return '0x1a2b';
  };
  return { request, calls, probes: () => probes };
}

void test('the probe allows a slow but working wallet', () => {
  // A wallet answering in 4s was reported dead at the old 3s timeout.
  assert.ok(WALLET_PROBE_TIMEOUT_MS >= 10_000);
});

void test('a wallet answering at 1, 2 and 4 units of a 5-unit timeout is reachable', async () => {
  for (const ms of [10, 20, 40]) {
    const wallet = stubWallet({ blockNumber: [ms] });
    assert.equal(
      await checkWalletRpc(wallet.request, X_LAYER, 50),
      'reachable',
    );
  }
});

void test('a wallet that never answers is unreachable only after two probes', async () => {
  const wallet = stubWallet({ blockNumber: [null] });
  assert.equal(
    await checkWalletRpc(wallet.request, X_LAYER, 20),
    'unreachable',
  );
  assert.equal(wallet.probes(), 2);
});

void test('one failed probe followed by an answer is reachable', async () => {
  const rpcError = Object.assign(new Error('Internal JSON-RPC error.'), {
    code: -32603,
  });
  for (const first of [null, rpcError]) {
    const wallet = stubWallet({ blockNumber: [first, 0] });
    assert.equal(
      await checkWalletRpc(wallet.request, X_LAYER, 20),
      'reachable',
    );
  }
});

void test('a locked or unapproved wallet is never judged', async () => {
  const wallet = stubWallet({ accounts: [], blockNumber: [null] });
  assert.equal(await checkWalletRpc(wallet.request, X_LAYER, 20), 'unknown');
  assert.equal(wallet.probes(), 0);
});

void test('a wallet on another chain is never judged', async () => {
  const wallet = stubWallet({ chainId: '0x1', blockNumber: [null] });
  assert.equal(await checkWalletRpc(wallet.request, X_LAYER, 20), 'unknown');
  assert.equal(wallet.probes(), 0);
});

void test('a wallet that stops answering its own settings is not judged', async () => {
  assert.equal(await checkWalletRpc(never, X_LAYER, 20), 'unknown');
});

void test('a wallet that leaves X Layer during the check is not judged', async () => {
  let chainId = '0x7a0';
  const request = async ({ method }: { method: string }) => {
    if (method === 'eth_accounts')
      return ['0xD95Bd9f3E641974515B53adE252AD43e7cB28059'];
    if (method === 'eth_chainId') return chainId;
    chainId = '0x1';
    return never();
  };
  assert.equal(await checkWalletRpc(request, X_LAYER, 20), 'unknown');
});
