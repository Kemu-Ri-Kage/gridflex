/**
 * How much a trade approves a market to pull, so repeat trades skip the
 * approval prompt. Kept free of React for the node tests.
 *
 * - An outcome token (YES or NO) is approved to its own market for the
 *   maximum. The market can already burn a holder's tokens (burn is
 *   onlyMarket in OutcomeToken.sol), so this grants nothing new, and
 *   OpenZeppelin's ERC20 never decrements a max allowance.
 * - MockUSDT is approved for the larger of the order and 1,000 mUSDT, one
 *   faucet tap. approve() sets the allowance rather than adding to it, so
 *   that is the most a market can ever pull. Collateral is never approved
 *   without a limit: the contracts aren't audited.
 */

export type ApprovalKind = 'collateral' | 'outcome';

/** 1,000 mUSDT at 6 decimals. */
export const COLLATERAL_APPROVAL_BUFFER = 1_000_000_000n;

export const MAX_ALLOWANCE = 2n ** 256n - 1n;

/** What to approve when the allowance doesn't cover `amount`. */
export function approvalTarget(kind: ApprovalKind, amount: bigint): bigint {
  if (kind === 'outcome') return MAX_ALLOWANCE;
  return amount > COLLATERAL_APPROVAL_BUFFER
    ? amount
    : COLLATERAL_APPROVAL_BUFFER;
}

/** Whether an allowance of `allowance` needs an approval for `amount`. */
export function needsApproval(allowance: bigint, amount: bigint): boolean {
  return allowance < amount;
}
