import { collateralShortfall } from './transaction-outcome.ts';

/**
 * The steps of one buy, supplied by the Web3Provider. Each transaction step
 * resolves true only once its receipt confirmed success; false means it
 * failed and has already reported why.
 */
export type BuySteps = {
  /** The wallet's mUSDT balance, read from the chain now. */
  readBalance: () => Promise<bigint>;
  /** The minimum swap output for the quote this buy is held to. */
  quoteMinimumSwapOut: () => Promise<bigint>;
  approveCollateral: () => Promise<boolean>;
  mintPair: () => Promise<boolean>;
  swap: (minimumSwapOut: bigint) => Promise<boolean>;
  recordPendingOrder: () => void;
  forgetPendingOrder: () => void;
  /** Report why the buy stopped; `cause` is the error behind it, if any. */
  fail: (message: string, cause?: unknown) => void;
};

/**
 * How a buy ended: `bought` (both steps confirmed), `stopped` (nothing
 * minted, so nothing to finish), or `pending` (the pair was minted but the
 * swap did not confirm, so an unfinished order is recorded).
 */
export type BuyOutcome = 'bought' | 'stopped' | 'pending';

/**
 * Buy with `units` mUSDT: check the balance, quote, approve, mint the
 * YES + NO pair, then swap the unwanted side. The unfinished order is
 * recorded only after the mint confirms and cleared only after the swap
 * confirms, so a reverted step can neither leave a phantom order nor drop
 * a real one.
 */
export async function runBuy(
  units: bigint,
  steps: BuySteps,
): Promise<BuyOutcome> {
  let minimumSwapOut: bigint;
  try {
    const shortfall = collateralShortfall(units, await steps.readBalance());
    if (shortfall) {
      steps.fail(shortfall);
      return 'stopped';
    }
    minimumSwapOut = await steps.quoteMinimumSwapOut();
  } catch (prepareError) {
    steps.fail('Could not prepare the order', prepareError);
    return 'stopped';
  }

  if (!(await steps.approveCollateral())) return 'stopped';
  if (!(await steps.mintPair())) return 'stopped';

  // The pair exists now. Record it before the swap, so a failed swap,
  // a market switch or a reload cannot lose track of it.
  steps.recordPendingOrder();
  if (!(await steps.swap(minimumSwapOut))) return 'pending';
  steps.forgetPendingOrder();
  return 'bought';
}
