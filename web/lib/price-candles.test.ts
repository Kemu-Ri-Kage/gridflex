import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bodyEdges,
  niceCeil,
  candleDirection,
  presetRange,
  priceWindow,
  scaleTop,
  skippedInRange,
  visibleIndices,
} from './price-candles.ts';

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

void test('presets set a visible range over all the data, never filter it', () => {
  assert.deepEqual(presetRange(376, '90d'), { from: 286, to: 375 });
  assert.deepEqual(presetRange(376, 'year'), { from: 0, to: 375 });
  // fewer days than the preset: everything
  assert.deepEqual(presetRange(40, '90d'), { from: 0, to: 39 });
});

void test('visible indices are the bars on screen, clamped to the data', () => {
  assert.deepEqual(visibleIndices(376, { from: 286, to: 375 }), { first: 286, last: 375 });
  // a bar whose centre is under half a bar off screen still shows
  assert.deepEqual(visibleIndices(376, { from: 285.4, to: 368.4 }), { first: 285, last: 368 });
  assert.deepEqual(visibleIndices(376, { from: -20, to: 400 }), { first: 0, last: 375 });
  assert.deepEqual(visibleIndices(376, null), { first: 0, last: 375 });
  assert.equal(visibleIndices(0, null), null);
  assert.equal(visibleIndices(376, { from: 380, to: 390 }), null);
});

void test('a calm window refits to its own prices, with every strike in range', () => {
  const calm = [
    { high: 5200, low: 2100, average: 3600 },
    { high: 4900, low: 2400, average: 3500 },
  ];
  assert.deepEqual(priceWindow(calm, [38, 40, 45]), { min: 21, max: 52, cap: null, spikes: 0 });
});

void test('a spike in view is capped and counted; one out of view does not stretch the scale', () => {
  const week = [
    { high: 5000, low: 2000, average: 4000 },
    { high: 23800, low: 2500, average: 4600 },
  ];
  // anchors: averages 40, 46 and strikes up to 45 -> 1.5 x 46 = 69, stated as $70
  assert.deepEqual(priceWindow(week, [38, 40, 45]), { min: 20, max: 70, cap: 70, spikes: 1 });
  assert.equal(priceWindow(week.slice(0, 1), [38, 40, 45])?.max, 50);
});

void test('a stated cap is rounded up to a plain figure', () => {
  assert.equal(niceCeil(98.69), 100);
  assert.equal(niceCeil(69), 70);
  assert.equal(niceCeil(1041.1), 1100);
  assert.equal(niceCeil(45), 45);
});
