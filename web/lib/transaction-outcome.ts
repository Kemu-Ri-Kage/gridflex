import { BaseError, ContractFunctionRevertedError, type Hash } from 'viem';

/**
 * A transaction the chain mined but reverted. A mined hash only means the
 * wallet sent it; the receipt's status says whether it did anything, and a
 * reverted step must stop the flow it belongs to.
 */
export class TransactionRevertedError extends Error {
  readonly hash: Hash;
  readonly step: string;
  readonly reason?: string;

  constructor(step: string, hash: Hash, reason?: string) {
    super(
      reason
        ? `${step} failed: the transaction reverted (${reason}).`
        : `${step} failed: the transaction reverted.`,
    );
    this.name = 'TransactionRevertedError';
    this.step = step;
    this.hash = hash;
    this.reason = reason;
  }
}

/** Plain wording for the reverts a trader can cause and fix. */
const REVERT_WORDING: Record<string, string> = {
  ERC20InsufficientBalance: 'not enough balance in the wallet',
  ERC20InsufficientAllowance: 'the approval does not cover the amount',
  SlippageExceeded: 'the price moved past the slippage limit',
  SwapDeadlineExpired: 'the 5-minute deadline passed',
  TradingClosed: 'trading on this market has closed',
  InsufficientOutput: 'the pool cannot fill this size',
  MarketAlreadySettled: 'the market is already settled',
  NothingToRedeem: 'nothing to redeem',
};

/**
 * The revert reason inside an error thrown by replaying a reverted call,
 * where viem decoded one: the require() string, or the custom error's name
 * (in plain words when it is one listed above).
 */
export function revertReason(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk(
    (cause) => cause instanceof ContractFunctionRevertedError,
  );
  if (!(reverted instanceof ContractFunctionRevertedError)) return undefined;
  const errorName = reverted.data?.errorName;
  if (errorName && errorName !== 'Error') {
    return REVERT_WORDING[errorName] ?? errorName;
  }
  return reverted.reason;
}

/**
 * Throw TransactionRevertedError when `receipt` reverted. `replay` re-runs
 * the call so the node reports why; it is best effort, and a replay that
 * does not revert or cannot run leaves the reason out.
 */
export async function assertTransactionSucceeded(
  step: string,
  receipt: { status: 'success' | 'reverted'; transactionHash: Hash },
  replay: () => Promise<unknown>,
): Promise<void> {
  if (receipt.status === 'success') return;
  let reason: string | undefined;
  try {
    await replay();
  } catch (replayError) {
    reason = revertReason(replayError);
  }
  throw new TransactionRevertedError(step, receipt.transactionHash, reason);
}

/**
 * Why a buy of `units` mUSDT cannot start with `balance` in the wallet, or
 * undefined when the balance covers it.
 */
export function collateralShortfall(
  units: bigint,
  balance: bigint,
): string | undefined {
  if (balance === 0n) return 'No mUSDT in this wallet. Get test mUSDT first.';
  if (units > balance) {
    return 'More than the mUSDT in this wallet. Lower the amount or get test mUSDT.';
  }
  return undefined;
}
