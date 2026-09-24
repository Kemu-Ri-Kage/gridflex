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
      'Approve 100 mUSDT',
      'Mint 100 YES + 100 NO',
      'Approve 100 NO for the swap',
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
    buySteps('YES', HUNDRED)[1].note,
    "Your wallet shows NO tokens here; that's expected.",
  );
  assert.equal(
    buySteps('NO', HUNDRED)[1].note,
    "Your wallet shows YES tokens here; that's expected.",
  );
});

void test('a NO buy swaps YES in, and names no estimate before a quote', () => {
  const steps = buySteps('NO', HUNDRED);
  assert.equal(steps[2].label, 'Approve 100 YES for the swap');
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
