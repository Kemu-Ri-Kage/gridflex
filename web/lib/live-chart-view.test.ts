import assert from 'node:assert/strict';
import { test } from 'node:test';

import { latestRange, liveWindow, MIN_BARS, switchRange } from './live-chart-view.ts';

const HOUR = 3600;
const hourly = Array.from({ length: 1000 }, (_, i) => i * HOUR);

void test('a timeframe opens on its latest candles, or all of them when there are fewer', () => {
  assert.deepEqual(latestRange(1000, 336), { from: 664, to: 999 });
  assert.deepEqual(latestRange(55, Number.POSITIVE_INFINITY), { from: 0, to: 54 });
});

void test('with no view to keep, a switch opens on the default', () => {
  assert.deepEqual(switchRange(hourly, 336, null), { from: 664, to: 999 });
});

void test('a kept view is found again in the new candles by time', () => {
  assert.deepEqual(switchRange(hourly, 336, { from: 100 * HOUR, to: 200 * HOUR }), { from: 100, to: 200 });
  // edges between candle starts land on the candle holding them
  assert.deepEqual(switchRange(hourly, 336, { from: 100.5 * HOUR, to: 200.5 * HOUR }), { from: 100, to: 200 });
});

void test('a short kept span is widened leftwards to the minimum candle count', () => {
  const range = switchRange(hourly, 336, { from: 500 * HOUR, to: 502 * HOUR });
  assert.deepEqual(range, { from: 502 - MIN_BARS + 1, to: 502 });
});

void test('a kept span outside the new candles falls back to the default', () => {
  assert.deepEqual(switchRange(hourly, 336, { from: -50 * HOUR, to: -10 * HOUR }), { from: 664, to: 999 });
});

void test('calm candles fit the scale to their full high and low', () => {
  const calm = [
    { open: 30, high: 36, low: 28, close: 34 },
    { open: 34, high: 41, low: 31, close: 38 },
  ];
  assert.deepEqual(liveWindow(calm), { min: 28, max: 41, cap: null, spikes: 0, floor: null, dips: 0 });
});

void test('a spike is capped at twice the typical candle top and counted', () => {
  const day = [
    ...Array.from({ length: 19 }, () => ({ open: 30, high: 35, low: 28, close: 32 })),
    { open: 32, high: 900, low: 30, close: 40 },
  ];
  // typical top 32 -> 64, stated as $65
  assert.deepEqual(liveWindow(day), { min: 28, max: 65, cap: 65, spikes: 1, floor: null, dips: 0 });
});

void test('the strike is always inside the range', () => {
  const calm = [{ open: 30, high: 36, low: 28, close: 34 }];
  assert.deepEqual(liveWindow(calm, 50), { min: 28, max: 50, cap: null, spikes: 0, floor: null, dips: 0 });
  assert.deepEqual(liveWindow(calm, 20), { min: 20, max: 36, cap: null, spikes: 0, floor: null, dips: 0 });
});

void test('a deep negative dip is floored; a shallow one and any low above zero never are', () => {
  const day = [
    ...Array.from({ length: 19 }, () => ({ open: 30, high: 55, low: 2, close: 50 })),
    { open: 30, high: 55, low: -116, close: 50 },
  ];
  // typical bodies 30-50, a range of 20 -> floor at -20; -116 is cut, the $2 lows stay
  assert.deepEqual(liveWindow(day), { min: -20, max: 55, cap: null, spikes: 0, floor: -20, dips: 1 });
  const shallow = [
    { open: 30, high: 55, low: 28, close: 50 },
    { open: 30, high: 55, low: -5, close: 50 },
  ];
  assert.equal(liveWindow(shallow)?.min, -5);
});
