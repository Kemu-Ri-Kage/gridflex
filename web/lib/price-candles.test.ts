import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bodyEdges, candleDirection, scaleTop, skippedInRange } from './price-candles.ts';

void test('a candle is up when it closes above its open, down below, flat when equal', () => {
  assert.equal(candleDirection({ open: 3000, close: 3100 }), 'up');
  assert.equal(candleDirection({ open: 3100, close: 3000 }), 'down');
  assert.equal(candleDirection({ open: 3000, close: 3000 }), 'flat');
});

void test('only skipped days inside the range on screen are counted', () => {
  const skipped = [
    { dayKey: 20251102, reason: '25/24 hours' },
    { dayKey: 20260308, reason: '23/24 hours' },
  ];
  assert.equal(skippedInRange(skipped, 20250910, 20260922), 2);
  assert.equal(skippedInRange(skipped, 20260625, 20260922), 0);
  assert.equal(skippedInRange(skipped, 20260308, 20260308), 1);
});

void test('the body spans open to close inside the high-low wick', () => {
  // high 100, low 0 over 200px: open 75 sits 50px down, close 25 at 150px
  assert.deepEqual(bodyEdges({ open: 75, high: 100, low: 0, close: 25 }, 10, 200), { top: 60, bottom: 160 });
  // an up day gives the same edges the other way round
  assert.deepEqual(bodyEdges({ open: 25, high: 100, low: 0, close: 75 }, 10, 200), { top: 60, bottom: 160 });
});

void test('a day with one price all day collapses to its top without dividing by zero', () => {
  assert.deepEqual(bodyEdges({ open: 50, high: 50, low: 50, close: 50 }, 10, 0), { top: 10, bottom: 10 });
});

void test('the scale reaches the highest high when it is near the averages and strikes', () => {
  assert.equal(scaleTop([46, 40, 45], [52, 60]), 60);
});

void test('a spike far above every average and strike is capped, not scaled to', () => {
  // highest anchor $46: the scale stops at $69, not at the $238 afternoon
  assert.equal(scaleTop([46, 40, 45], [60, 238]), 69);
});

void test('a scale with no positive average or strike falls back to the highest high', () => {
  assert.equal(scaleTop([-5, 0], [12]), 12);
});
