import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  approvalTarget,
  COLLATERAL_APPROVAL_BUFFER,
  MAX_ALLOWANCE,
  needsApproval,
} from './allowance.ts';

void test('an outcome token is approved to its market for the maximum', () => {
  assert.equal(approvalTarget('outcome', 100_000_000n), MAX_ALLOWANCE);
  assert.equal(MAX_ALLOWANCE, (1n << 256n) - 1n);
});

void test('mUSDT is approved for one faucet tap when the order is smaller', () => {
  assert.equal(COLLATERAL_APPROVAL_BUFFER, 1_000n * 10n ** 6n);
  assert.equal(
    approvalTarget('collateral', 100_000_000n),
    COLLATERAL_APPROVAL_BUFFER,
  );
});

void test('mUSDT is approved for the order when it exceeds the buffer', () => {
  assert.equal(approvalTarget('collateral', 2_500_000_000n), 2_500_000_000n);
});

void test('mUSDT is never approved without a limit', () => {
  assert.notEqual(approvalTarget('collateral', 1n), MAX_ALLOWANCE);
});

void test('ten 100 mUSDT buys fit one buffer; the eleventh approves again', () => {
  let allowance = 0n;
  let approvals = 0;
  for (let i = 0; i < 11; i++) {
    if (needsApproval(allowance, 100_000_000n)) {
      allowance = approvalTarget('collateral', 100_000_000n);
      approvals++;
    }
    allowance -= 100_000_000n; // transferFrom in mintSet
  }
  assert.equal(approvals, 2);
});

void test('an allowance that covers the amount skips the approval', () => {
  assert.equal(needsApproval(100n, 100n), false);
  assert.equal(needsApproval(99n, 100n), true);
});
