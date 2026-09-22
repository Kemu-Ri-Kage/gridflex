import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_SLIPPAGE_BPS,
  minimumOutputForQuote,
  parsePositiveTokenAmount,
  percentOfBalance,
  swapDeadline,
} from './trade.ts';

void test('parsePositiveTokenAmount accepts six-decimal token amounts', () => {
  assert.equal(parsePositiveTokenAmount('1'), 1_000_000n);
  assert.equal(parsePositiveTokenAmount(' 12.345678 '), 12_345_678n);
});

void test('parsePositiveTokenAmount rejects unsafe or ambiguous input', () => {
  for (const value of ['', '0', '-1', '1.0000001', '1e6', 'not-a-number']) {
    assert.throws(() => parsePositiveTokenAmount(value));
  }
});

void test('minimumOutputForQuote applies the default 0.5% tolerance with floor rounding', () => {
  assert.equal(DEFAULT_SLIPPAGE_BPS, 50n);
  assert.equal(minimumOutputForQuote(909_090_909n), 904_545_454n);
});

void test('minimumOutputForQuote rejects zero output and invalid tolerance', () => {
  assert.throws(() => minimumOutputForQuote(0n));
  assert.throws(() => minimumOutputForQuote(1n, -1n));
  assert.throws(() => minimumOutputForQuote(1n, 10_000n));
  assert.throws(() => minimumOutputForQuote(1n, 50n));
});

void test('swapDeadline adds five minutes and enforces uint64 bounds', () => {
  assert.equal(swapDeadline(1_800_000_000n), 1_800_000_300n);
  assert.throws(() => swapDeadline(-1n));
  assert.throws(() => swapDeadline(1n, 0n));
  assert.throws(() => swapDeadline((1n << 64n) - 1n));
});

void test('percentOfBalance rounds down and returns the exact balance at 100%', () => {
  assert.equal(percentOfBalance(19_990_009n, 25), 4_997_502n);
  assert.equal(percentOfBalance(19_990_009n, 50), 9_995_004n);
  assert.equal(percentOfBalance(19_990_009n, 75), 14_992_506n);
  assert.equal(percentOfBalance(19_990_009n, 100), 19_990_009n);
  assert.equal(percentOfBalance(3n, 25), 0n);
  assert.equal(percentOfBalance(0n, 100), 0n);
});
