import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buyPreview,
  closeLabel,
  dayLabel,
  defaultLimitCents,
  maxPayoutCents,
  strikeGrid,
} from './options-view.ts';

const BAND = { floorCents: -5000, capCents: 30_000 };

void test('the screen reads $5 strikes from $5 to $120 inside the band', () => {
  const grid = strikeGrid(BAND);
  assert.equal(grid.length, 24);
  assert.equal(grid[0], 500);
  assert.equal(grid.at(-1), 12_000);
  assert.deepEqual(
    strikeGrid({ floorCents: 0, capCents: 2000 }),
    [500, 1000, 1500],
  );
});

void test('a buy matches what the contract escrows and can pay (TexasPowerOptionsTest)', () => {
  // testBuyFillsAtTheNextQuoteAndRefundsTheRest: 10 MWh $45 call, limit $3.00, ask $2.10
  const p = buyPreview({
    size: 10_000n,
    askCents: 210,
    limitCents: 300,
    strikeCents: 4500,
    isCall: true,
    band: BAND,
  });
  assert.equal(p.escrow, 30_000_000n);
  assert.equal(p.costAtAsk, 21_000_000n);
  assert.equal(p.maxPayout, 2_550_000_000n); // 10 MWh x ($300 - $45)
  assert.equal(p.problem, null);
  assert.equal(maxPayoutCents(4000, false, BAND), 9000); // a $40 put pays at most $90
});

void test('the preview says why a buy would not fill', () => {
  const base = {
    size: 10_000n,
    askCents: 210,
    limitCents: 300,
    strikeCents: 4500,
    isCall: true,
    band: BAND,
  };
  assert.match(buyPreview({ ...base, size: 50n }).problem!, /at least 0.1 MWh/);
  assert.match(
    buyPreview({ ...base, limitCents: 25_501 }).problem!,
    /at most \$255.00/,
  );
  assert.match(
    buyPreview({ ...base, limitCents: 200 }).problem!,
    /above your limit/,
  );
});

void test('the default limit leaves room for a small move between quotes', () => {
  assert.equal(defaultLimitCents(210, 25_500), 221);
  assert.equal(defaultLimitCents(2, 25_500), 3);
  assert.equal(defaultLimitCents(25_400, 25_500), 25_500);
});

void test('days read as weekday, day and month', () => {
  assert.equal(dayLabel(20261111), 'Wed 11 Nov');
});

void test('closeLabel shows the date as well as the Texas time of the close', () => {
  // 12:30 Texas (CST, UTC-6) on Tue 10 Nov closes the Wed 11 Nov expiry
  assert.equal(
    closeLabel(Date.UTC(2026, 10, 10, 18, 30) / 1000),
    'Tue 10 Nov, 12:30',
  );
  // daylight time (UTC-5) in summer
  assert.equal(
    closeLabel(Date.UTC(2026, 6, 14, 17, 30) / 1000),
    'Tue 14 Jul, 12:30',
  );
});
