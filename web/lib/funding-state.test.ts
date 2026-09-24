import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fundingState, NO_GAS_MESSAGE } from './funding-state.ts';

const WALLET = '0x1111111111111111111111111111111111111111';
const MUSDT = 10n ** 6n;
const OKB = 10n ** 17n; // 0.1 OKB

const connected = {
  account: WALLET,
  balanceAccount: WALLET,
  balance: 0n,
  gasBalance: OKB,
  units: 100n * MUSDT,
  tradingOpen: true,
};

void test('zero mUSDT: the ticket leads with getting test mUSDT and Buy is not ready', () => {
  const funding = fundingState(connected);
  assert.equal(funding.balance, 0n);
  assert.equal(funding.needsMusdt, true);
  assert.equal(funding.fundsReady, false);
  // The lead block says it; nothing under Amount repeats it.
  assert.equal(funding.shortfall, undefined);
});

void test('after minting 1,000 test mUSDT the same wallet is ready to buy', () => {
  const before = fundingState(connected);
  const after = fundingState({ ...connected, balance: 1_000n * MUSDT });
  assert.equal(before.fundsReady, false);
  assert.equal(after.needsMusdt, false);
  assert.equal(after.balance, 1_000n * MUSDT);
  assert.equal(after.shortfall, undefined);
  assert.equal(after.fundsReady, true);
});

void test('an amount above the balance blocks Buy and says why', () => {
  const funding = fundingState({
    ...connected,
    balance: 50n * MUSDT,
    units: 100n * MUSDT,
  });
  assert.equal(funding.needsMusdt, false);
  assert.match(funding.shortfall ?? '', /More than the mUSDT in this wallet/);
  assert.equal(funding.fundsReady, false);
});

void test('an amount equal to the balance is allowed', () => {
  const funding = fundingState({
    ...connected,
    balance: 100n * MUSDT,
    units: 100n * MUSDT,
  });
  assert.equal(funding.shortfall, undefined);
  assert.equal(funding.fundsReady, true);
});

void test('a balance not yet read for this wallet shows no zero state and no Buy', () => {
  for (const balanceAccount of [
    undefined,
    '0x2222222222222222222222222222222222222222',
  ]) {
    const funding = fundingState({ ...connected, balanceAccount });
    assert.equal(funding.balance, undefined);
    assert.equal(funding.needsMusdt, false);
    assert.equal(funding.needsGas, false);
    assert.equal(funding.fundsReady, false);
  }
});

void test('the balance read matches the wallet whatever the address case', () => {
  const funding = fundingState({
    ...connected,
    balanceAccount: WALLET.toUpperCase().replace('0X', '0x'),
    balance: 1_000n * MUSDT,
  });
  assert.equal(funding.fundsReady, true);
});

void test('a fresh wallet with no OKB and no mUSDT needs both, faucet first', () => {
  const funding = fundingState({ ...connected, gasBalance: 0n });
  assert.equal(funding.needsGas, true);
  assert.equal(funding.needsMusdt, true);
  assert.equal(funding.fundsReady, false);
});

void test('mUSDT but no OKB: Buy is blocked with the gas reason', () => {
  const funding = fundingState({
    ...connected,
    balance: 1_000n * MUSDT,
    gasBalance: 0n,
  });
  assert.equal(funding.needsMusdt, false);
  assert.equal(funding.needsGas, true);
  assert.equal(funding.shortfall, NO_GAS_MESSAGE);
  assert.equal(funding.fundsReady, false);
});

void test('an invalid amount is not ready but is not a funding problem', () => {
  const funding = fundingState({
    ...connected,
    balance: 1_000n * MUSDT,
    units: undefined,
  });
  assert.equal(funding.shortfall, undefined);
  assert.equal(funding.fundsReady, false);
});

void test('with trading closed there is nothing to fund', () => {
  const funding = fundingState({
    ...connected,
    gasBalance: 0n,
    tradingOpen: false,
  });
  assert.equal(funding.needsMusdt, false);
  assert.equal(funding.needsGas, false);
  assert.equal(funding.shortfall, undefined);
  assert.equal(funding.fundsReady, false);
});

void test('no wallet connected: nothing is known', () => {
  const funding = fundingState({ ...connected, account: undefined });
  assert.equal(funding.balance, undefined);
  assert.equal(funding.needsMusdt, false);
});
