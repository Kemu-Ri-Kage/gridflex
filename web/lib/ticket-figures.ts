import { formatSignedToken, formatToken } from './format.ts';
import { sideLabel } from './sides.ts';

/**
 * The order ticket's plain-money figures, from numbers it already holds:
 * a buy's premium (what it costs), its max payout and its max loss. No
 * React, so they are tested directly.
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

/** A quoted buy in 6-decimal mUSDT units: premium paid, max payout if its side pays, and the difference. */
export interface QuoteFigures {
  kind: 'quote';
  pay: bigint;
  receive: bigint;
  gain: bigint;
}

/** A quoted buy's figures, or the one line saying why there is nothing to promise yet. */
export type PayoutFigures = QuoteFigures | { kind: 'message'; text: string };

function message(text: string): PayoutFigures {
  return { kind: 'message', text };
}

/**
 * What a buy costs and returns, as figures the ticket lays out itself.
 * Each Long or Short contract pays 1 mUSDT if its side pays at settlement
 * and nothing otherwise, so the contracts bought are the max payout and the
 * whole premium is the max loss. Without a quote, a valid amount or open
 * trading it returns the message instead and promises nothing.
 */
export function payoutFigures(input: PayoutInput): PayoutFigures {
  if (!input.ready) return message('—');
  if (!input.tradingOpen) return message('Trading closed.');
  if (input.units === undefined) return message('Enter an amount in mUSDT.');
  const pay = `Premium ${formatToken(input.units)} mUSDT`;
  if (input.quoteUnavailable) return message(`${pay} → no live quote`);
  if (input.totalOut === undefined) return message(`${pay} → quoting…`);
  return {
    kind: 'quote',
    pay: input.units,
    receive: input.totalOut,
    gain: input.totalOut - input.units,
  };
}

/**
 * payoutFigures as one line, e.g. "Premium 100 mUSDT → max payout 190.45
 * mUSDT if Long pays (+90.45). Max loss 100 mUSDT."
 */
export function payoutLine(input: PayoutInput): string {
  const figures = payoutFigures(input);
  if (figures.kind === 'message') return figures.text;
  return (
    `Premium ${formatToken(figures.pay)} mUSDT → max payout ${formatToken(figures.receive)} mUSDT if ${sideLabel(input.side)} pays ` +
    `(${formatSignedToken(figures.gain)}). Max loss ${formatToken(figures.pay)} mUSDT.`
  );
}
