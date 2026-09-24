import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  onOpenPortfolio,
  openPortfolio,
  portfolioRows,
  portfolioTotals,
  redeemableMarkets,
  redeemEach,
  winningsLine,
  type RedeemStatus,
} from './portfolio.ts';

const E18 = 10n ** 18n;
const trading = { resolved: false, cancelled: false, yesWon: false, priceE18: 600_000_000_000_000_000n };
const yesWon = { resolved: true, cancelled: false, yesWon: true, priceE18: E18 };
const noWon = { resolved: true, cancelled: false, yesWon: false, priceE18: 0n };
const cancelled = { resolved: false, cancelled: true, yesWon: false, priceE18: 400_000_000_000_000_000n };

const markets = [
  { address: '0xA', live: trading },
  { address: '0xB', live: yesWon },
  { address: '0xC', live: noWon },
  { address: '0xD', live: cancelled },
  { address: '0xE' },
];

void test('a trading market is marked at the pool price, indicative, nothing to redeem', () => {
  const [row] = portfolioRows(markets, { '0xA': { yes: 10_000_000n, no: 5_000_000n } });
  // 10 YES at 60c + 5 NO at 40c.
  assert.deepEqual(row, {
    address: '0xA',
    yes: 10_000_000n,
    no: 5_000_000n,
    value: 8_000_000n,
    basis: 'indicative',
    redeemable: 0n,
  });
});

void test('a resolved market is worth its payout and counts the losing side as 0', () => {
  const [row] = portfolioRows(markets, { '0xB': { yes: 19_990_000n, no: 3_000_000n } });
  assert.deepEqual(row, {
    address: '0xB',
    yes: 19_990_000n,
    no: 0n,
    value: 19_990_000n,
    basis: 'payout',
    redeemable: 19_990_000n,
  });
});

void test('a cancelled market pays half of each side, rounded down as the contract does', () => {
  const [row] = portfolioRows(markets, { '0xD': { yes: 3n, no: 0n } });
  assert.equal(row.value, 1n);
  assert.equal(row.redeemable, 1n);
  assert.equal(row.basis, 'payout');
});

void test('only a losing side, or nothing, leaves the market out', () => {
  const rows = portfolioRows(markets, {
    '0xB': { yes: 0n, no: 3_000_000n },
    '0xC': { yes: 7n, no: 0n },
    '0xA': { yes: 0n, no: 0n },
  });
  assert.deepEqual(rows, []);
});

void test('a market redeemed this session stays listed with nothing left', () => {
  const [row] = portfolioRows(markets, { '0xB': { yes: 0n, no: 3_000_000n } }, new Set(['0xB']));
  assert.equal(row.address, '0xB');
  assert.equal(row.value, 0n);
  assert.equal(row.redeemable, 0n);
});

void test('a market whose state is still loading has no value yet', () => {
  const [row] = portfolioRows(markets, { '0xE': { yes: 1n, no: 0n } });
  assert.equal(row.value, undefined);
  assert.equal(row.basis, undefined);
  assert.equal(row.redeemable, 0n);
});

void test('rows follow the market order and skip markets not read yet', () => {
  const rows = portfolioRows(markets, {
    '0xD': { yes: 2n, no: 2n },
    '0xA': { yes: 1n, no: 0n },
    '0xZ': { yes: 1n, no: 1n },
  });
  assert.deepEqual(rows.map((row) => row.address), ['0xA', '0xD']);
});

void test('totals add every row and find what is redeemable across markets', () => {
  const rows = portfolioRows(markets, {
    '0xA': { yes: 10_000_000n, no: 0n },
    '0xB': { yes: 19_990_000n, no: 0n },
    '0xC': { yes: 0n, no: 1_000_000n },
    '0xE': { yes: 5n, no: 0n },
  });
  assert.deepEqual(portfolioTotals(rows), {
    value: 6_000_000n + 19_990_000n + 1_000_000n,
    indicative: true,
    redeemable: 20_990_000n,
    redeemableMarkets: 2,
  });
  assert.deepEqual(redeemableMarkets(rows), ['0xB', '0xC']);
});

void test('the winnings line counts markets and says nothing when nothing is redeemable', () => {
  const one = portfolioTotals(portfolioRows(markets, { '0xB': { yes: 19_990_000n, no: 0n } }));
  assert.equal(winningsLine(one), 'You have 19.99 mUSDT to redeem on 1 market');
  const two = portfolioTotals(
    portfolioRows(markets, { '0xB': { yes: 1_000_000n, no: 0n }, '0xD': { yes: 2_000_000n, no: 0n } }),
  );
  assert.equal(winningsLine(two), 'You have 2 mUSDT to redeem on 2 markets');
  assert.equal(winningsLine(portfolioTotals([])), undefined);
});

void test('dust too small for 2 decimals is shown in full, never as 0', () => {
  const dust = portfolioTotals(portfolioRows(markets, { '0xB': { yes: 4_000n, no: 0n } }));
  assert.equal(winningsLine(dust), 'You have 0.004 mUSDT to redeem on 1 market');
});

void test('redeem all goes one market at a time and carries on past a failure', async () => {
  const log: string[] = [];
  let inFlight = 0;
  const result = await redeemEach(
    ['0xB', '0xC', '0xD'],
    async (address) => {
      inFlight += 1;
      assert.equal(inFlight, 1);
      await Promise.resolve();
      inFlight -= 1;
      if (address === '0xB') return false;
      if (address === '0xC') throw new Error('rejected');
      return true;
    },
    (address: string, status: RedeemStatus) => log.push(`${address}:${status}`),
  );
  assert.deepEqual(result, { redeemed: ['0xD'], failed: ['0xB', '0xC'] });
  assert.deepEqual(log, [
    '0xB:waiting',
    '0xC:waiting',
    '0xD:waiting',
    '0xB:redeeming',
    '0xB:failed',
    '0xC:redeeming',
    '0xC:failed',
    '0xD:redeeming',
    '0xD:redeemed',
  ]);
});

void test('openPortfolio reaches every listener until it unsubscribes', () => {
  let opened = 0;
  const stop = onOpenPortfolio(() => {
    opened += 1;
  });
  openPortfolio();
  stop();
  openPortfolio();
  assert.equal(opened, 1);
});
