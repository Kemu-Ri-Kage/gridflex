import assert from 'node:assert/strict';
import { test } from 'node:test';

import { yesCostFor } from './hedge.ts';
import {
  centsAmount,
  costCents,
  hedgeView,
  stripView,
  STRIP_DAYS,
  inputNumber,
  scenarioPrices,
  tradingDays,
  wholeTokens,
} from './hedge-view.ts';

// 1,000 YES and 1,000 NO in the pool, in 6-decimal units
const POOL = { yesReserve: 1_000_000_000n, noReserve: 1_000_000_000n };

void test('typed inputs read as numbers, anything blank or not above 0 as 0', () => {
  assert.equal(inputNumber('10'), 10);
  assert.equal(inputNumber('7.5'), 7.5);
  assert.equal(inputNumber(''), 0);
  assert.equal(inputNumber('  '), 0);
  assert.equal(inputNumber('-3'), 0);
  assert.equal(inputNumber('abc'), 0);
});

void test('token units are 6-decimal', () => {
  assert.equal(wholeTokens(1_234_567n), 1.234567);
});

void test('a cost rounds up to the cent, ignoring float noise', () => {
  assert.equal(costCents(12.3), 1230);
  assert.equal(costCents(12.301), 1231);
  assert.equal(costCents(0.001), 1);
  assert.equal(centsAmount(123457), '1234.57');
  assert.equal(centsAmount(5), '0.05');
});

void test('scenario prices are the strikes, the protected price and $60/$80/$100, deduped and sorted', () => {
  assert.deepEqual(scenarioPrices([50, 40, 60], 80), [40, 50, 60, 80, 100]);
  assert.deepEqual(scenarioPrices([], 120), [60, 80, 100, 120]);
});

void test('each rung is costed from its own pool, rounded up, and the total adds the rounded costs', () => {
  const view = hedgeView(10, 24, 80, [
    { address: '0xb', strike: 50, ...POOL },
    { address: '0xa', strike: 40, ...POOL },
  ]);
  assert.equal(view.mwh, 240);
  assert.deepEqual(
    view.rows.map(({ address, strike, tokens }) => ({ address, strike, tokens })),
    [
      { address: '0xa', strike: 40, tokens: 2400 },
      { address: '0xb', strike: 50, tokens: 7200 },
    ],
  );
  const first = view.rows[0];
  assert.equal(first.costCents, Math.ceil(yesCostFor(2400, 1000, 1000) * 100));
  assert.equal(first.amount, centsAmount(first.costCents ?? 0));
  assert.equal(view.totalCents, (view.rows[0].costCents ?? 0) + (view.rows[1].costCents ?? 0));
  assert.deepEqual(
    view.scenarios.map((s) => s.price),
    [40, 50, 60, 80, 100],
  );
  // at the protected price the ladder pays the whole extra cost over $40
  const at80 = view.scenarios.find((s) => s.price === 80);
  assert.equal(at80?.extraCost, 240 * 40);
  assert.equal(at80?.payout, 240 * 40);
  assert.equal(at80?.covered, 1);
});

void test('an unread or empty pool leaves its rung uncosted and the total unknown', () => {
  const view = hedgeView(10, 24, 80, [
    { address: '0xa', strike: 40, ...POOL },
    { address: '0xb', strike: 50 },
    { address: '0xc', strike: 60, yesReserve: 0n, noReserve: 1n },
  ]);
  assert.equal(view.rows.length, 3);
  assert.ok(view.rows[0].amount);
  assert.equal(view.rows[1].costCents, undefined);
  assert.equal(view.rows[2].amount, undefined);
  assert.equal(view.totalCents, undefined);
});

void test('the first market on a strike is the one bought', () => {
  const view = hedgeView(1, 24, 80, [
    { address: '0xfirst', strike: 40, ...POOL },
    { address: '0xsecond', strike: 40, ...POOL },
  ]);
  assert.deepEqual(view.rows.map((row) => row.address), ['0xfirst']);
});

void test('no load, or nothing below the protected price, says why instead of a ladder', () => {
  assert.equal(hedgeView(0, 24, 80, [{ address: '0xa', strike: 40 }]).problem, 'load');
  assert.equal(hedgeView(10, 25, 80, [{ address: '0xa', strike: 40 }]).problem, 'load');
  const high = hedgeView(10, 24, 40, [{ address: '0xa', strike: 40 }]);
  assert.equal(high.problem, 'protect');
  assert.deepEqual(high.rows, []);
  assert.deepEqual(high.scenarios, []);
});

void test('trading days are listed earliest first, each with its first market in list order', () => {
  const days = tradingDays([
    { dayKey: 20260926, address: '0x1' },
    { dayKey: 20260925, address: '0x2' },
    { dayKey: 20260926, address: '0x3' },
    { dayKey: 20260925, address: '0x4' },
  ]);
  assert.deepEqual(days, [
    { dayKey: 20260925, address: '0x2' },
    { dayKey: 20260926, address: '0x1' },
  ]);
});

void test('a week strip repeats the day ladder on each market day and adds it up', () => {
  const pool = { yesReserve: 10_000_000_000n, noReserve: 10_000_000_000n };
  const day = (dayKey: number, strikes: number[]) => ({
    dayKey,
    markets: strikes.map((strike) => ({ address: `0x${dayKey}${strike}`, strike, ...pool })),
  });
  const strip = stripView(10, 24, 80, [day(20260926, [35, 45]), day(20260927, [35, 45]), day(20260928, [90])]);
  // the 28th has no strike below $80: skipped, not covered
  assert.deepEqual(strip.skipped, [20260928]);
  assert.equal(strip.days.length, 2);
  const oneDay = hedgeView(10, 24, 80, day(20260926, [35, 45]).markets);
  assert.equal(strip.totalCents, 2 * (oneDay.totalCents ?? 0));
  // every day at $80: two days of 240 MWh x $45 extra, fully paid
  const at80 = strip.scenarios.find((s) => s.price === 80);
  assert.equal(at80?.extraCost, 2 * 240 * 45);
  assert.equal(at80?.payout, 2 * 240 * 45);
  assert.equal(at80?.covered, 1);
  assert.equal(stripView(0, 24, 80, [day(20260926, [35])]).problem, 'load');
  assert.equal(stripView(10, 24, 30, [day(20260926, [35])]).problem, 'protect');
});

void test('a strip covers at most a week of market days', () => {
  const days = Array.from({ length: 9 }, (_, i) => ({
    dayKey: 20260926 + i,
    markets: [{ address: `0x${i}`, strike: 35 }],
  }));
  assert.equal(stripView(1, 24, 80, days).days.length, STRIP_DAYS);
});
