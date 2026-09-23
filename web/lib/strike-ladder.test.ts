import assert from 'node:assert/strict';
import { test } from 'node:test';

import { labelLeft, niceScale, pastFrequency, spreadLabels, strikeLines } from './strike-ladder.ts';

void test('one line per strike, highest first, with every day at that strike', () => {
  const markets = [
    { address: 'a', dayKey: 20260908, threshold: 3000 },
    { address: 'b', dayKey: 20260926, threshold: 4500 },
    { address: 'c', dayKey: 20260930, threshold: 4500 },
    { address: 'd', dayKey: 20261002, threshold: 4500 },
    { address: 'e', dayKey: 20260930, threshold: 4000 },
    { address: 'f', dayKey: 20261002, threshold: 3800 },
  ];
  assert.deepEqual(strikeLines(markets, 'e'), [
    { threshold: 4500, dayKeys: [20260926, 20260930, 20261002], selected: false },
    { threshold: 4000, dayKeys: [20260930], selected: true },
    { threshold: 3800, dayKeys: [20261002], selected: false },
    { threshold: 3000, dayKeys: [20260908], selected: false },
  ]);
  assert.equal(strikeLines(markets, undefined).filter((l) => l.selected).length, 0);
});

void test('labels closer than the gap are spread apart, in their original order', () => {
  // $40 and $38 lines 8px apart need 14px between their labels.
  assert.deepEqual(spreadLabels([100, 108, 20], 14, 0, 200), [100, 114, 20]);
  // Lines far apart are left where they are.
  assert.deepEqual(spreadLabels([50, 150], 14, 0, 200), [50, 150]);
});

void test('labels pushed past the bottom are pushed back up, keeping the gap', () => {
  assert.deepEqual(spreadLabels([195, 198, 199], 10, 0, 200), [180, 190, 200]);
});

const day = (dayKey: number, value: number) => ({ dayKey, value });

void test('past frequency counts strictly above the strike, as the contract settles', () => {
  const records = [day(20260901, 3999), day(20260902, 4000), day(20260903, 4001), day(20260904, 5000)];
  // $40.00 exactly settles NO, so it is not counted as above.
  assert.deepEqual(pastFrequency(records, 4000, 20260930, 30), {
    above: 2,
    days: 4,
    lastDayKey: 20260904,
  });
});

void test('past frequency covers the last N days before the market day only', () => {
  const records = [
    day(20260926, 9000),
    day(20260927, 1000),
    day(20260928, 9000),
    day(20260929, 9000),
    day(20260930, 9000), // the market's own day: never counted
  ];
  assert.deepEqual(pastFrequency(records, 4000, 20260930, 2), {
    above: 2,
    days: 2,
    lastDayKey: 20260929,
  });
  assert.deepEqual(pastFrequency(records, 4000, 20260926, 30), {
    above: 0,
    days: 0,
    lastDayKey: null,
  });
});

void test('the y range takes in every value on round ticks', () => {
  // 90 days: $10 steps. Full year, with the $694 spike: $100 steps.
  assert.deepEqual(niceScale([18.2, 72.4, 45, 30]), {
    domain: [10, 80],
    ticks: [10, 20, 30, 40, 50, 60, 70, 80],
  });
  assert.deepEqual(niceScale([15.1, 694.03, 45]), {
    domain: [0, 700],
    ticks: [0, 100, 200, 300, 400, 500, 600, 700],
  });
});

void test('a strike label moves right of the attribution mark only where it would overlap it', () => {
  // 300px pane: the mark covers y 271-290 and x 10-45
  assert.equal(labelLeft(100, 14, 300), 4);
  assert.equal(labelLeft(280, 14, 300), 51);
  // a label whose line only touches the mark's top edge still moves
  assert.equal(labelLeft(265, 14, 300), 51);
  // clear above the mark
  assert.equal(labelLeft(263, 14, 300), 4);
});
