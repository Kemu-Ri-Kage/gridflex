import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatBlockTime,
  formatCentsE18,
  formatCentsShort,
  formatSignedPercent,
  formatSignedToken,
  formatTokenExact,
  formatUpdated,
  signedTokenDirection,
} from './format.ts';

void test('formatUpdated: Texas summer time and UTC', () => {
  assert.equal(
    formatUpdated('2026-09-22T11:03:32Z'),
    '22 Sep 2026, 06:03 CDT (Texas) · 11:03 UTC',
  );
});

void test('formatUpdated: Texas winter time and UTC', () => {
  assert.equal(
    formatUpdated('2026-12-01T18:30:00Z'),
    '1 Dec 2026, 12:30 CST (Texas) · 18:30 UTC',
  );
});

void test('formatUpdated: repeats the UTC date when it has already rolled over', () => {
  assert.equal(
    formatUpdated('2026-09-23T03:15:00Z'),
    '22 Sep 2026, 22:15 CDT (Texas) · 23 Sep 2026, 03:15 UTC',
  );
});

void test('formatUpdated: accepts Python isoformat with microseconds and an offset', () => {
  assert.equal(
    formatUpdated('2026-09-21T21:35:55.518448+00:00'),
    '21 Sep 2026, 16:35 CDT (Texas) · 21:35 UTC',
  );
});

void test('formatUpdated: missing or unparseable input gives null', () => {
  assert.equal(formatUpdated(null), null);
  assert.equal(formatUpdated(undefined), null);
  assert.equal(formatUpdated(''), null);
  assert.equal(formatUpdated('not a date'), null);
});

void test('formatCentsE18 shows a token price in cents', () => {
  assert.equal(formatCentsE18(500_250_000_000_000_000n), '50.0¢');
  assert.equal(formatCentsE18(10n ** 18n), '100.0¢');
  assert.equal(formatCentsE18(0n), '0.0¢');
});

void test('formatSignedToken always shows the sign of a P&L', () => {
  assert.equal(formatSignedToken(1_994_005n), '+1.99');
  assert.equal(formatSignedToken(-420_000n), '−0.42');
  assert.equal(formatSignedToken(0n), '0.00');
  assert.equal(formatSignedToken(1_994n), '0.00');
  assert.equal(formatSignedToken(-1_994n), '0.00');
});

void test('formatSignedPercent signs the P&L percentage', () => {
  assert.equal(formatSignedPercent(0.1994005), '+19.9%');
  assert.equal(formatSignedPercent(-0.042), '−4.2%');
  assert.equal(formatSignedPercent(0.0002), '0.0%');
});

void test('formatTokenExact keeps all six decimals', () => {
  assert.equal(formatTokenExact(9_995_004n), '9.995004');
  assert.equal(formatTokenExact(19_990_009n), '19.990009');
  assert.equal(formatTokenExact(1_000_000_000n), '1,000');
});

void test('signedTokenDirection: a P&L that shows as 0.00 is flat, not up or down', () => {
  assert.equal(signedTokenDirection(1_994_005n), 'up');
  assert.equal(signedTokenDirection(-420_000n), 'down');
  assert.equal(signedTokenDirection(0n), 'flat');
  assert.equal(signedTokenDirection(1_994n), 'flat');
  assert.equal(signedTokenDirection(-1_994n), 'flat');
});

void test('formatBlockTime: a block time in UTC', () => {
  assert.equal(formatBlockTime(1790116275), '22 Sep 2026, 22:31 UTC');
});

void test('formatCentsShort rounds to whole cents but keeps a decimal near 0 and 100', () => {
  assert.equal(formatCentsShort(523_400_000_000_000_000n), '52¢');
  assert.equal(formatCentsShort(500_000_000_000_000_000n), '50¢');
  assert.equal(formatCentsShort(4_000_000_000_000_000n), '0.4¢');
  assert.equal(formatCentsShort(996_000_000_000_000_000n), '99.6¢');
  assert.equal(formatCentsShort(0n), '0¢');
  assert.equal(formatCentsShort(10n ** 18n), '100¢');
});
