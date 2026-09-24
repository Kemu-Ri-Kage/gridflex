import assert from 'node:assert/strict';
import { test } from 'node:test';

import { closesIn } from './closes-in.ts';

const NOW = 1_790_000_000_000;

void test('time left to trade, in the two largest units', () => {
  assert.equal(closesIn(NOW / 1000 + 6 * 86_400 + 18 * 3_600 + 59, NOW), '6d 18h');
  assert.equal(closesIn(NOW / 1000 + 3 * 3_600 + 12 * 60, NOW), '3h 12m');
  assert.equal(closesIn(NOW / 1000 + 12 * 60 + 30, NOW), '12m');
  assert.equal(closesIn(NOW / 1000 + 20, NOW), '1m');
});

void test('nothing once trading has closed', () => {
  assert.equal(closesIn(NOW / 1000, NOW), null);
  assert.equal(closesIn(NOW / 1000 - 60, NOW), null);
});
