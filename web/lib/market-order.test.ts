import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareMarkets } from './market-order.ts';

void test('markets sort by day, newest first, then by strike, highest first', () => {
  // addresses.json order: markets appended as they were created.
  const listed = [
    { dayKey: 20260908, threshold: 3000 },
    { dayKey: 20260926, threshold: 4500 },
    { dayKey: 20260930, threshold: 4500 },
    { dayKey: 20261002, threshold: 4500 },
    { dayKey: 20260930, threshold: 4000 },
    { dayKey: 20261002, threshold: 3800 },
  ];
  assert.deepEqual(listed.toSorted(compareMarkets), [
    { dayKey: 20261002, threshold: 4500 },
    { dayKey: 20261002, threshold: 3800 },
    { dayKey: 20260930, threshold: 4500 },
    { dayKey: 20260930, threshold: 4000 },
    { dayKey: 20260926, threshold: 4500 },
    { dayKey: 20260908, threshold: 3000 },
  ]);
});
