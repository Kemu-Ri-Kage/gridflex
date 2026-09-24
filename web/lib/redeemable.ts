/**
 * What BinaryMarket.redeem() would pay this wallet now, mirroring the
 * contract: nothing before settlement; the winning side's balance once
 * resolved (the losing side stays in the wallet, worth nothing); half of
 * each side, as the average of the two balances, once cancelled. Zero means
 * redeem() would revert with NothingToRedeem. Kept free of React for the
 * node tests.
 */

export interface SettlementState {
  resolved: boolean;
  cancelled: boolean;
  yesWon: boolean;
}

export function redeemablePayout(
  state: SettlementState,
  yes: bigint,
  no: bigint,
): bigint {
  if (state.cancelled) return (yes + no) / 2n;
  if (!state.resolved) return 0n;
  return state.yesWon ? yes : no;
}

/** The side that pays nothing once resolved; none while open or cancelled. */
export function losingSide(state: SettlementState): 'YES' | 'NO' | undefined {
  if (!state.resolved || state.cancelled) return undefined;
  return state.yesWon ? 'NO' : 'YES';
}
