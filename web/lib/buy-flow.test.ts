import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runBuy, type BuySteps } from './buy-flow.ts';

const UNITS = 100_000_000n; // 100 mUSDT

/** Steps that all succeed, recording what ran; override one to fail it. */
function steps(overrides: Partial<BuySteps> = {}) {
  const ran: string[] = [];
  const failures: string[] = [];
  const all: BuySteps = {
    readBalance: async () => 1_000_000_000n,
    quoteMinimumSwapOut: async () => 90_000_000n,
    approveCollateral: async () => (ran.push('approve'), true),
    mintPair: async () => (ran.push('mint'), true),
    swap: async () => (ran.push('swap'), true),
    recordPendingOrder: () => void ran.push('record'),
    forgetPendingOrder: () => void ran.push('forget'),
    fail: (message) => void failures.push(message),
    ...overrides,
  };
  return { all, ran, failures };
}

void test('a buy whose steps all confirm records, then clears, the unfinished order', async () => {
  const { all, ran, failures } = steps();
  assert.equal(await runBuy(UNITS, all), 'bought');
  assert.deepEqual(ran, ['approve', 'mint', 'record', 'swap', 'forget']);
  assert.deepEqual(failures, []);
});

void test('a buy with no mUSDT stops before any transaction, with an error', async () => {
  const { all, ran, failures } = steps({ readBalance: async () => 0n });
  assert.equal(await runBuy(UNITS, all), 'stopped');
  assert.deepEqual(ran, []);
  assert.match(failures[0], /No mUSDT/);
});

void test('a buy larger than the balance stops before any transaction, with an error', async () => {
  const { all, ran, failures } = steps({
    readBalance: async () => UNITS - 1n,
  });
  assert.equal(await runBuy(UNITS, all), 'stopped');
  assert.deepEqual(ran, []);
  assert.match(failures[0], /More than the mUSDT/);
});

void test('a buy of exactly the balance goes ahead', async () => {
  const { all } = steps({ readBalance: async () => UNITS });
  assert.equal(await runBuy(UNITS, all), 'bought');
});

void test('a balance that cannot be read stops the buy rather than guessing', async () => {
  const { all, ran, failures } = steps({
    readBalance: async () => {
      throw new Error('RPC down');
    },
  });
  assert.equal(await runBuy(UNITS, all), 'stopped');
  assert.deepEqual(ran, []);
  assert.equal(failures[0], 'Could not prepare the order');
});

void test('a reverted mint stops the buy and records no unfinished order', async () => {
  const { all, ran } = steps({
    mintPair: async () => false,
  });
  assert.equal(await runBuy(UNITS, all), 'stopped');
  assert.deepEqual(ran, ['approve']);
});

void test('a reverted approval stops the buy before the mint', async () => {
  const { all, ran } = steps({ approveCollateral: async () => false });
  assert.equal(await runBuy(UNITS, all), 'stopped');
  assert.deepEqual(ran, []);
});

void test('a reverted swap keeps the unfinished order for the pair the mint made', async () => {
  const { all, ran } = steps({ swap: async () => false });
  assert.equal(await runBuy(UNITS, all), 'pending');
  // Recorded once, never cleared: the wallet holds YES + NO and the ticket
  // must offer Finish order / Keep both sides.
  assert.deepEqual(ran, ['approve', 'mint', 'record']);
});

void test('the swap is held to the quote taken before the mint', async () => {
  let minimum: bigint | undefined;
  const { all } = steps({
    swap: async (minimumSwapOut) => ((minimum = minimumSwapOut), true),
  });
  await runBuy(UNITS, all);
  assert.equal(minimum, 90_000_000n);
});
