import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FAUCET_GAS_BELOW_WEI,
  FAUCET_MUSDT_BELOW_UNITS,
  faucetMessage,
  faucetPlan,
} from './faucet.ts';

void test('a brand-new wallet gets both gas and mUSDT', () => {
  assert.deepEqual(faucetPlan({ gasWei: 0n, musdtUnits: 0n }), { gas: true, musdt: true });
});

void test('a funded wallet gets nothing, so the same wallet cannot keep collecting', () => {
  assert.deepEqual(
    faucetPlan({ gasWei: FAUCET_GAS_BELOW_WEI, musdtUnits: FAUCET_MUSDT_BELOW_UNITS }),
    { gas: false, musdt: false },
  );
});

void test('only the low side is topped up', () => {
  assert.deepEqual(faucetPlan({ gasWei: 0n, musdtUnits: 5_000_000_000n }), { gas: true, musdt: false });
  assert.deepEqual(faucetPlan({ gasWei: 10n ** 17n, musdtUnits: 0n }), { gas: false, musdt: true });
});

void test('the message names what was sent', () => {
  assert.equal(faucetMessage({ gas: '0x1', musdt: '0x2' }), 'Sent: 1,000 test mUSDT and test OKB for gas.');
  assert.equal(faucetMessage({ musdt: '0x2' }), 'Sent: 1,000 test mUSDT.');
  assert.equal(faucetMessage({ gas: '0x1' }), 'Sent: test OKB for gas.');
  assert.equal(faucetMessage({}), 'This wallet already has test funds.');
});
