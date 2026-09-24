import assert from 'node:assert/strict';
import { test } from 'node:test';

import { losingSide, redeemablePayout } from './redeemable.ts';

const open = { resolved: false, cancelled: false, yesWon: false };
const yesWon = { resolved: true, cancelled: false, yesWon: true };
const noWon = { resolved: true, cancelled: false, yesWon: false };
const cancelled = { resolved: false, cancelled: true, yesWon: false };

// The demo wallet on the 2 Oct $45 market: 414.532495 YES, 1.196798 NO.
const YES = 414_532_495n;
const NO = 1_196_798n;

void test('nothing is redeemable before settlement', () => {
  assert.equal(redeemablePayout(open, YES, NO), 0n);
});

void test('once resolved, only the winning side pays', () => {
  assert.equal(redeemablePayout(yesWon, YES, NO), YES);
  assert.equal(redeemablePayout(noWon, YES, NO), NO);
});

void test('after a YES-win redeem, the leftover NO leaves nothing to collect', () => {
  // redeem() burned the YES; the NO stays in the wallet.
  assert.equal(redeemablePayout(yesWon, 0n, NO), 0n);
});

void test('once cancelled, both sides pay half, rounded down as the contract does', () => {
  assert.equal(redeemablePayout(cancelled, YES, NO), 207_864_646n);
  assert.equal(redeemablePayout(cancelled, 1n, 0n), 0n);
});

void test('the losing side is known only once resolved', () => {
  assert.equal(losingSide(open), undefined);
  assert.equal(losingSide(cancelled), undefined);
  assert.equal(losingSide(yesWon), 'NO');
  assert.equal(losingSide(noWon), 'YES');
});
