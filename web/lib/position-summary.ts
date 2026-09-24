import { formatToken } from './format.ts';

/**
 * A wallet's holding on one market as the order ticket states it: matched
 * YES + NO pairs (each pays 1 mUSDT at settlement whichever side wins) and
 * the net side left over. BinaryMarket has no exit into mUSDT before
 * settlement, so buying the other side never closes a position; it only
 * adds pairs. Kept free of React for the node tests.
 */

type Side = 'YES' | 'NO';

export interface PositionSummary {
  yes: bigint;
  no: bigint;
  /** min(YES, NO): pays that many mUSDT at settlement, either outcome. */
  pairs: bigint;
  /** What's left after the pairs, or undefined when YES equals NO. */
  net?: { side: Side; amount: bigint };
}

export function positionSummary(
  yes: bigint,
  no: bigint,
): PositionSummary | undefined {
  if (yes === 0n && no === 0n) return undefined;
  const pairs = yes < no ? yes : no;
  const net =
    yes > no
      ? { side: 'YES' as const, amount: yes - no }
      : no > yes
        ? { side: 'NO' as const, amount: no - yes }
        : undefined;
  return { yes, no, pairs, net };
}

/** "Pays 192 mUSDT if above $45 · else 0"; YES wins only strictly above the strike. */
export function paysLabel(side: Side, amount: bigint, strike: string): string {
  const condition = side === 'YES' ? `above ${strike}` : `${strike} or below`;
  return `Pays ${formatToken(amount)} mUSDT if ${condition} · else 0`;
}

/** "150 mUSDT at settlement, either outcome". */
export function pairsLabel(pairs: bigint): string {
  return `${formatToken(pairs)} mUSDT at settlement, either outcome`;
}

/**
 * The warning before buying the side opposite the wallet's net position,
 * or undefined when the buy adds to it (or there is none).
 */
export function oppositeBuyWarning(
  summary: PositionSummary | undefined,
  buying: Side,
): string | undefined {
  const net = summary?.net;
  if (!net || net.side === buying) return undefined;
  return `Opens ${buying} beside your ${formatToken(net.amount)} ${net.side}; doesn't sell it.`;
}
