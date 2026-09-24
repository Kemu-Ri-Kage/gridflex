import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  type Abi,
  type Hash,
} from 'viem';

import {
  assertTransactionSucceeded,
  collateralShortfall,
  revertReason,
  TransactionRevertedError,
} from './transaction-outcome.ts';

const HASH: Hash =
  '0x1111111111111111111111111111111111111111111111111111111111111111';

const errorsAbi = [
  {
    type: 'error',
    name: 'ERC20InsufficientBalance',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'balance', type: 'uint256' },
      { name: 'needed', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'SlippageExceeded',
    inputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'minimumAmountOut', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'Unlisted', inputs: [] },
] as const satisfies Abi;

/** What viem throws when a replayed call reverts with `data`. */
function replayError(data: `0x${string}`) {
  return new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({
      abi: errorsAbi,
      data,
      functionName: 'mintSet',
    }),
    { abi: errorsAbi, functionName: 'mintSet' },
  );
}

void test('a successful receipt passes without replaying', async () => {
  let replayed = false;
  await assertTransactionSucceeded(
    'Minting the YES + NO pair',
    { status: 'success', transactionHash: HASH },
    async () => {
      replayed = true;
    },
  );
  assert.equal(replayed, false);
});

void test('a reverted receipt throws, naming the step, hash and decoded reason', async () => {
  const data = encodeErrorResult({
    abi: errorsAbi,
    errorName: 'ERC20InsufficientBalance',
    args: ['0x00000000000000000000000000000000000000aa', 0n, 100n],
  });
  await assert.rejects(
    assertTransactionSucceeded(
      'Minting the YES + NO pair',
      { status: 'reverted', transactionHash: HASH },
      async () => {
        throw replayError(data);
      },
    ),
    (error) => {
      assert.ok(error instanceof TransactionRevertedError);
      assert.equal(error.hash, HASH);
      assert.equal(error.step, 'Minting the YES + NO pair');
      assert.equal(
        error.message,
        'Minting the YES + NO pair failed: the transaction reverted (not enough balance in the wallet).',
      );
      return true;
    },
  );
});

void test('a reverted swap reports the slippage guard in plain words', async () => {
  const data = encodeErrorResult({
    abi: errorsAbi,
    errorName: 'SlippageExceeded',
    args: [1n, 2n],
  });
  assert.equal(
    revertReason(replayError(data)),
    'the price moved past the slippage limit',
  );
});

void test('an unlisted custom error is reported by name', () => {
  const data = encodeErrorResult({ abi: errorsAbi, errorName: 'Unlisted' });
  assert.equal(revertReason(replayError(data)), 'Unlisted');
});

void test('a reverted receipt still throws when the replay gives no reason', async () => {
  for (const replay of [
    async () => undefined, // state moved on; the replay succeeded
    async () => {
      throw new Error('historical state unavailable');
    },
  ]) {
    await assert.rejects(
      assertTransactionSucceeded(
        'Swapping NO into YES',
        { status: 'reverted', transactionHash: HASH },
        replay,
      ),
      {
        name: 'TransactionRevertedError',
        message: 'Swapping NO into YES failed: the transaction reverted.',
      },
    );
  }
});

void test('collateral shortfall: none, all, or part of the amount', () => {
  assert.match(collateralShortfall(1n, 0n) ?? '', /No mUSDT/);
  assert.match(collateralShortfall(101n, 100n) ?? '', /More than the mUSDT/);
  assert.equal(collateralShortfall(100n, 100n), undefined);
});
