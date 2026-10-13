import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buyStepLabel,
  buySteps,
  markBuyStep,
  startBuyProgress,
} from './buy-steps.ts';

const HUNDRED = 100_000_000n; // 100 mUSDT

void test('a Long (YES) buy lists its four prompts in the order the wallet shows them', () => {
  const steps = buySteps('YES', HUNDRED, 92_340_000n);
  assert.deepEqual(
    steps.map((step) => step.label),
    [
      'Approve 1,000 mUSDT for this market',
      'Mint 100 Long + 100 Short',
      'Approve the NO token (Short) for this market (one time)',
      'Swap 100 Short for ~92.34 Long',
    ],
  );
  assert.deepEqual(
    steps.map((step) => step.approval),
    [true, false, true, false],
  );
});

void test('the mint step says the wallet will show the other side', () => {
  assert.equal(
    buySteps('YES', HUNDRED).find((step) => step.key === 'mint')?.note,
    "Your wallet shows NO tokens (Short) here; that's expected.",
  );
  assert.equal(
    buySteps('NO', HUNDRED).find((step) => step.key === 'mint')?.note,
    "Your wallet shows YES tokens (Long) here; that's expected.",
  );
});

void test('a Short (NO) buy swaps Long in, and names no estimate before a quote', () => {
  const steps = buySteps('NO', HUNDRED);
  assert.equal(steps[2].label, 'Approve the YES token (Long) for this market (one time)');
  assert.equal(steps[3].label, 'Swap 100 Long into Short');
});

void test('the spinner names the step by number', () => {
  const steps = buySteps('YES', HUNDRED);
  assert.equal(
    buyStepLabel(steps, 'mint'),
    'Step 2 of 4 · Mint 100 Long + 100 Short',
  );
});

void test('only one step is ever waiting: the next one closes the last', () => {
  let progress = startBuyProgress(buySteps('YES', HUNDRED));
  progress = markBuyStep(progress, 'approveCollateral', 'skipped');
  progress = markBuyStep(progress, 'mint', 'current');
  progress = markBuyStep(progress, 'approveSwap', 'current');
  assert.deepEqual(progress.status, {
    approveCollateral: 'skipped',
    mint: 'done',
    approveSwap: 'current',
    swap: 'upcoming',
  });
  progress = markBuyStep(progress, 'swap', 'current');
  assert.equal(
    Object.values(progress.status).filter((s) => s === 'current').length,
    1,
  );
  assert.equal(progress.status.approveSwap, 'done');
});

void test('an order over 1,000 mUSDT approves the order, not the buffer', () => {
  assert.equal(
    buySteps('YES', 2_500_000_000n)[0].label,
    'Approve 2,500 mUSDT for this market',
  );
});

void test('a repeat buy with both approvals in place lists two prompts', () => {
  const steps = buySteps('YES', HUNDRED, 92_340_000n, {
    collateral: false,
    swap: false,
  });
  assert.deepEqual(
    steps.map((step) => step.label),
    ['Mint 100 Long + 100 Short', 'Swap 100 Short for ~92.34 Long'],
  );
  assert.equal(
    buyStepLabel(steps, 'swap'),
    'Step 2 of 2 · Swap 100 Short for ~92.34 Long',
  );
});

void test('a first buy of the other side lists only its swap approval', () => {
  const steps = buySteps('NO', HUNDRED, undefined, {
    collateral: false,
    swap: true,
  });
  assert.deepEqual(
    steps.map((step) => step.key),
    ['mint', 'approveSwap', 'swap'],
  );
});

void test('an approval left out of the list still gets a spinner label', () => {
  const steps = buySteps('YES', HUNDRED, undefined, {
    collateral: false,
    swap: false,
  });
  assert.equal(buyStepLabel(steps, 'approveCollateral'), 'Approving mUSDT');
});
