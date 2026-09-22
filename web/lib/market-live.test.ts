import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Abi, Address } from 'viem';

import { keepSettled, readMarketsLive, type LiveRead, type MarketLive } from './market-live.ts';

const ABI = [] as Abi;
const A = '0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1' as Address;
const B = '0x62D65F4e15CdC15EC4A1cf707EE6ba4A5cF4BE07' as Address;

const live = (over: Partial<MarketLive> = {}): MarketLive => ({
  resolved: false,
  cancelled: false,
  yesWon: false,
  priceE18: 5n * 10n ** 17n,
  ...over,
});

void test('every market is read in one multicall, so all fields share one block', async () => {
  const calls: LiveRead[][] = [];
  const multicall = async (contracts: LiveRead[]) => {
    calls.push(contracts);
    return [true, false, true, 10n ** 18n, false, false, false, 5n * 10n ** 17n];
  };
  const states = await readMarketsLive(multicall, ABI, [A, B]);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].map((c) => [c.address, c.functionName]),
    [
      [A, 'resolved'],
      [A, 'cancelled'],
      [A, 'yesWon'],
      [A, 'price'],
      [B, 'resolved'],
      [B, 'cancelled'],
      [B, 'yesWon'],
      [B, 'price'],
    ],
  );
  assert.deepEqual(states, [
    live({ resolved: true, yesWon: true, priceE18: 10n ** 18n }),
    live(),
  ]);
});

void test('no markets means no call', async () => {
  let called = false;
  const states = await readMarketsLive(
    async () => {
      called = true;
      return [];
    },
    ABI,
    [],
  );
  assert.deepEqual(states, []);
  assert.equal(called, false);
});

void test('a failed or short multicall is an error, never a partial snapshot', async () => {
  await assert.rejects(readMarketsLive(async () => [true, false], ABI, [A]), /Expected 4 results/);
  await assert.rejects(
    readMarketsLive(
      async () => {
        throw new Error('rpc down');
      },
      ABI,
      [A],
    ),
    /rpc down/,
  );
});

void test('a lagging node on a later poll cannot un-settle a market', () => {
  const resolvedYes = live({ resolved: true, yesWon: true });
  const stale = live(); // the node hasn't reached the resolve block
  const merged = keepSettled({ [A]: resolvedYes }, { [A]: stale });
  assert.deepEqual(merged[A], resolvedYes);
});

void test('a cancelled market stays cancelled too', () => {
  const cancelled = live({ cancelled: true });
  assert.deepEqual(keepSettled({ [A]: cancelled }, { [A]: live() })[A], cancelled);
});

void test('unsettled markets take the newest poll, and new markets pass through', () => {
  const merged = keepSettled(
    { [A]: live({ priceE18: 1n }) },
    { [A]: live({ priceE18: 2n }), [B]: live({ resolved: true }) },
  );
  assert.equal(merged[A].priceE18, 2n);
  assert.equal(merged[B].resolved, true);
});
