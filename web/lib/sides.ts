/**
 * The two sides of every market in derivatives words. On chain a market
 * mints a YES and a NO token (BinaryMarket.sol); financially the pair is a
 * cash-settled digital option. YES is the Long, a digital call that pays
 * 1 mUSDT per contract if the day settles strictly above the strike
 * (resolve(): `reading.value > threshold`); NO is the Short, a digital put
 * that pays 1 mUSDT if it settles at or below it.
 *
 * The site says Long and Short. The token symbols a wallet shows stay YES
 * and NO (they are on chain), and the code and the machine API keep
 * 'YES' | 'NO' as a side's identity, so only the words change here.
 */

export type Side = 'YES' | 'NO';

export type SideLabel = 'Long' | 'Short';

export const SIDE_LABEL: Record<Side, SideLabel> = { YES: 'Long', NO: 'Short' };

/** "Long" for YES, "Short" for NO. */
export function sideLabel(side: Side): SideLabel {
  return SIDE_LABEL[side];
}

/** The on-chain token that holds a side, as a wallet names it: "YES token". */
export function sideToken(side: Side): string {
  return `${side} token`;
}

/**
 * A message built elsewhere with token words ("Switching to NO", "Swapping
 * NO into YES failed") in side words ("Switching to Short"). Only the
 * upper-case whole words change, so "No wallet found" is left alone.
 */
export function inSideWords(text: string): string {
  return text.replace(/\bYES\b/g, SIDE_LABEL.YES).replace(/\bNO\b/g, SIDE_LABEL.NO);
}
