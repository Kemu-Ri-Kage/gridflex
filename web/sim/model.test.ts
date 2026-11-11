import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clamp,
  closeAmounts,
  escrowForOpen,
  expectedOpen,
  expectedOptionFill,
  fee,
  fillRound,
  FundingModel,
  indexAt,
  openTerms,
  payoffCents,
  type Band,
  type PublishedRound,
} from './model.ts';

const band: Band = { floorCents: -5000n, capCents: 30_000n };
const rounds = (prices: number[], start = 1_000_200, gapAfter = -1): PublishedRound[] =>
  prices.map((p, i) => ({
    priceCents: BigInt(p),
    intervalEnd: start + 300 * i + (gapAfter >= 0 && i > gapAfter ? 300 : 0),
    publishedAt: start + 300 * i + 60,
  }));

void test('the index averages three back-to-back rounds, toward zero', () => {
  const r = rounds([4000, 4100, 4201, -100, -100, -101]);
  assert.equal(indexAt(r, 2), null);
  assert.equal(indexAt(r, 3), 4100n); // 12301 / 3 = 4100.33
  assert.equal(indexAt(r, 6), -100n); // -301 / 3 = -100.33, toward zero
});

void test('a missed interval means no index until three in a row again', () => {
  const r = rounds([4000, 4000, 4000, 4000, 4000, 4000], 1_000_200, 2);
  assert.equal(indexAt(r, 3), 4000n);
  assert.equal(indexAt(r, 4), null);
  assert.equal(indexAt(r, 5), null);
  assert.equal(indexAt(r, 6), 4000n);
});

void test('the fill round is the first published strictly after the order', () => {
  const r = rounds([4000, 4000, 4000]);
  assert.equal(fillRound(r, r[0].publishedAt - 1), 1);
  assert.equal(fillRound(r, r[0].publishedAt), 2);
  assert.equal(fillRound(r, r[2].publishedAt), null);
});

void test('opens cancel at the band edges and beyond the limit', () => {
  const at = (index: bigint | null, isLong = true, limit = 4500n, marketPaused = false) =>
    expectedOpen({ isLong, limitCents: limit, index, marketPaused, band });
  assert.deepEqual(at(4000n), { fill: 4000n });
  assert.deepEqual(at(4600n), { cancel: 'price beyond the limit' });
  assert.deepEqual(at(4400n, false), { cancel: 'price beyond the limit' });
  assert.deepEqual(at(75_000n), { cancel: 'price on a band edge' });
  assert.deepEqual(at(-5000n, true, 4500n), { cancel: 'price on a band edge' });
  assert.deepEqual(at(null), { cancel: 'no index at the fill round' });
  assert.deepEqual(at(4000n, true, 4500n, true), { cancel: 'market paused' });
});

void test('collateral is the most a position can lose, the reserve the most it can win', () => {
  // 1 MWh long at $40: loses at most $90 (to -$50), wins at most $260 (to $300)
  const long = openTerms(true, 1000n, 4000n, band);
  assert.equal(long.collateral, 90_000_000n);
  assert.equal(long.reserve, 260_000_000n);
  const short = openTerms(false, 1000n, 4000n, band);
  assert.equal(short.collateral, 260_000_000n);
  assert.equal(short.reserve, 90_000_000n);
});

void test('fees and the escrow for the worst fill', () => {
  // 0.10% of 10 MWh at $40 = $0.40
  assert.equal(fee(10_000n, 4000n, 10n), 400_000n);
  assert.equal(fee(10_000n, -4000n, 10n), 400_000n);
  // a long limited at $45 escrows $95/MWh plus 0.10% of $300/MWh
  assert.equal(escrowForOpen(true, 1000n, 4500n, band, 10n), 95_000_000n + 300_000n);
});

void test('a close pays collateral + gain - funding - fee, never below zero', () => {
  const base = { isLong: true, size: 1000n, entryCents: 4000n, collateral: 90_000_000n, funding: 0n, feeBps: 10n };
  assert.deepEqual(closeAmounts({ ...base, exitCents: 30_000n }), { pnl: 260_000_000n, fee: 300_000n, payout: 349_700_000n });
  assert.deepEqual(closeAmounts({ ...base, exitCents: -5000n }), { pnl: -90_000_000n, fee: 50_000n, payout: 0n });
});

void test('funding: the bigger side pays max x imbalance / total per MWh per hour', () => {
  const f = new FundingModel(1n, 0);
  f.open(0, 'a', true, 3000n); // 3 MWh long
  f.open(0, 'b', false, 1000n); // 1 MWh short
  // one hour: longs pay 1 cent x (2/4) per MWh = 0.5 cent/MWh, 3 MWh -> 1.5 cents = 15,000 units
  assert.equal(f.close(3600, 'a'), 15_000n);
  assert.equal(f.owedUnits('b'), 0n);
  // b alone now pays the full rate: half an hour on 1 MWh = 0.5 cent
  assert.equal(f.close(5400, 'b'), 5_000n);
});

void test('options pay the clamped settlement against the strike', () => {
  assert.equal(payoffCents(4500n, 4000n, true, band), 500n);
  assert.equal(payoffCents(45_000n, 4000n, true, band), 26_000n); // capped at $300
  assert.equal(payoffCents(-8000n, 4000n, false, band), 9000n); // floored at -$50
  assert.equal(payoffCents(3500n, 4000n, true, band), 0n);
  assert.equal(clamp(-6000n, band), -5000n);
});

void test('options orders fill at the quote or cancel', () => {
  const quote = { callAsk: 120n, callBid: 100n, putAsk: 80n, putBid: 0n };
  assert.deepEqual(expectedOptionFill({ isBuy: true, isCall: true, limitCents: 130n, quote }), { premium: 120n });
  assert.deepEqual(expectedOptionFill({ isBuy: true, isCall: true, limitCents: 110n, quote }), { cancel: 'premium beyond the limit' });
  assert.deepEqual(expectedOptionFill({ isBuy: false, isCall: false, limitCents: 0n, quote }), { cancel: 'strike not quoted' });
  assert.deepEqual(expectedOptionFill({ isBuy: true, isCall: true, limitCents: 130n, quote: undefined }), { cancel: 'strike not quoted' });
});
