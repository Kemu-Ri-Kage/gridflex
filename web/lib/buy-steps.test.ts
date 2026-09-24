import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buyStepLabel,
  buySteps,
  markBuyStep,
  startBuyProgress,
} from './buy-steps.ts';

const HUNDRED = 100_000_000n; // 100 mUSDT

void test('a YES buy lists its four prompts in the order the wallet shows them', () => {
  const steps = buySteps('YES', HUNDRED, 92_340_000n);
  assert.deepEqual(
    steps.map((step) => step.label),
    [
      'Approve 1,000 mUSDT for this market',
      'Mint 100 YES + 100 NO',
      'Approve NO for this market (one time)',
      'Swap 100 NO for ~92.34 YES',
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
    "Your wallet shows NO tokens here; that's expected.",
  );
  assert.equal(
    buySteps('NO', HUNDRED).find((step) => step.key === 'mint')?.note,
    "Your wallet shows YES tokens here; that's expected.",
  );
});

void test('a NO buy swaps YES in, and names no estimate before a quote', () => {
  const steps = buySteps('NO', HUNDRED);
  assert.equal(steps[2].label, 'Approve YES for this market (one time)');
  assert.equal(steps[3].label, 'Swap 100 YES into NO');
});

void test('the spinner names the step by number', () => {
  const steps = buySteps('YES', HUNDRED);
  assert.equal(
    buyStepLabel(steps, 'mint'),
    'Step 2 of 4 · Mint 100 YES + 100 NO',
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
    ['Mint 100 YES + 100 NO', 'Swap 100 NO for ~92.34 YES'],
  );
  assert.equal(
    buyStepLabel(steps, 'swap'),
    'Step 2 of 2 · Swap 100 NO for ~92.34 YES',
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
