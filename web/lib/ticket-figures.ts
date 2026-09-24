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

/** A quoted buy in 6-decimal mUSDT units: paid, received if its side wins, and the difference. */
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
 * What a buy pays and returns, as figures the ticket lays out itself. Each
 * YES or NO pays 1 mUSDT if its side wins and nothing if it loses, so the
 * tokens bought are the payout and the whole amount paid is the most that
 * can be lost. Without a quote, a valid amount or open trading it returns
 * the message instead and promises nothing.
 */
export function payoutFigures(input: PayoutInput): PayoutFigures {
  if (!input.ready) return message('—');
  if (!input.tradingOpen) return message('Trading closed.');
  if (input.units === undefined) return message('Enter an amount in mUSDT.');
  const pay = `Pay ${formatToken(input.units)} mUSDT`;
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
 * payoutFigures as one line, e.g. "Pay 100 mUSDT → receive 190.45 mUSDT
 * if YES wins (+90.45). Max loss 100 mUSDT."
 */
export function payoutLine(input: PayoutInput): string {
  const figures = payoutFigures(input);
  if (figures.kind === 'message') return figures.text;
  return (
    `Pay ${formatToken(figures.pay)} mUSDT → receive ${formatToken(figures.receive)} mUSDT if ${input.side} wins ` +
    `(${formatSignedToken(figures.gain)}). Max loss ${formatToken(figures.pay)} mUSDT.`
  );
}
