import { formatSignedToken, formatToken } from './format.ts';

/**
 * The order ticket's plain-money figures, from numbers it already holds:
 * what a buy pays and returns. No React, so they are tested directly.
 */

export interface PayoutInput {
  side: 'YES' | 'NO';
  /** The amount typed, in 6-decimal mUSDT units; undefined when it isn't a valid amount. */
  units: bigint | undefined;
  /** The quote's totalOut: the `side` tokens held after the buy, in 6-decimal units. */
  totalOut: bigint | undefined;
  /** The market has been read; false while it loads. */
  ready: boolean;
  tradingOpen: boolean;
  /** The quote for this amount failed. */
  quoteUnavailable: boolean;
}

/**
 * What a buy pays and returns, e.g. "Pay 100 mUSDT → receive 190.45 mUSDT
 * if YES wins (+90.45). Max loss 100 mUSDT." Each YES or NO pays 1 mUSDT
 * if its side wins and nothing if it loses, so the tokens bought are the
 * payout and the whole amount paid is the most that can be lost.
 */
export function payoutLine(input: PayoutInput): string {
  if (!input.ready) return '—';
  if (!input.tradingOpen) return 'Trading closed.';
  if (input.units === undefined) return 'Enter an amount in mUSDT.';
  const pay = `Pay ${formatToken(input.units)} mUSDT`;
  if (input.quoteUnavailable) return `${pay} → no live quote`;
  if (input.totalOut === undefined) return `${pay} → quoting…`;
  return (
    `${pay} → receive ${formatToken(input.totalOut)} mUSDT if ${input.side} wins ` +
    `(${formatSignedToken(input.totalOut - input.units)}). Max loss ${formatToken(input.units)} mUSDT.`
  );
}
