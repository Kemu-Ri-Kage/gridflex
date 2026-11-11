/**
 * The market simulation's own model of what the contracts should do, written
 * from their rules (contracts/README.md and the NatSpec), not copied from the
 * Solidity. Every fill, fee, funding charge, payout and settlement the chain
 * reports is compared with these numbers.
 *
 * Units, as in the contracts: sizes are thousandths of a MWh (1,000 = 1 MWh),
 * prices are cents per MWh, collateral has 6 decimals, so 1 cent on 1 MWh is
 * 10,000 units and 1 cent on one size unit is 10 units.
 */

export const UNITS_PER_CENT_SIZE = 10n;
export const BPS = 10_000n;

export interface Band {
  floorCents: bigint;
  capCents: bigint;
}

export interface PublishedRound {
  priceCents: bigint;
  /** Unix seconds. */
  intervalEnd: number;
  /** Block time it was published, unix seconds. */
  publishedAt: number;
}

export const value = (size: bigint, cents: bigint): bigint =>
  size * cents * UNITS_PER_CENT_SIZE;

export const clamp = (cents: bigint, band: Band): bigint =>
  cents < band.floorCents
    ? band.floorCents
    : cents > band.capCents
      ? band.capCents
      : cents;

const abs = (x: bigint) => (x < 0n ? -x : x);

/**
 * The GRIDFLEX Texas Live Index at a round (1-based): the average of that
 * round and the two before it, rounded toward zero, only when the three
 * intervals are back to back. Null across a gap or before the third round.
 */
export function indexAt(
  rounds: readonly PublishedRound[],
  roundId: number,
  intervalSeconds = 300,
): bigint | null {
  if (roundId < 3 || roundId > rounds.length) return null;
  const [a, b, c] = [rounds[roundId - 3], rounds[roundId - 2], rounds[roundId - 1]];
  if (
    b.intervalEnd !== a.intervalEnd + intervalSeconds ||
    c.intervalEnd !== b.intervalEnd + intervalSeconds
  )
    return null;
  // BigInt division rounds toward zero, as the plan says
  return (a.priceCents + b.priceCents + c.priceCents) / 3n;
}

/** The fill round: the first round published strictly after the request's block time. */
export function fillRound(
  rounds: readonly PublishedRound[],
  createdAt: number,
): number | null {
  for (let i = 0; i < rounds.length; i++)
    if (rounds[i].publishedAt > createdAt) return i + 1;
  return null;
}

// ------------------------------------------------------------------ futures

/** The pool's set-aside while an open order waits: the whole band, the most any fill can need. */
export const reserveForOrder = (size: bigint, band: Band) =>
  value(size, band.capCents - band.floorCents);

export const fee = (size: bigint, priceCents: bigint, feeBps: bigint) =>
  (value(size, abs(priceCents)) * feeBps) / BPS;

/** What a request to open escrows: the worst loss at the trader's limit plus the largest fee. */
export function escrowForOpen(
  isLong: boolean,
  size: bigint,
  limitCents: bigint,
  band: Band,
  feeBps: bigint,
): bigint {
  const worstMove = isLong
    ? limitCents - band.floorCents
    : band.capCents - limitCents;
  const widest =
    band.capCents > -band.floorCents ? band.capCents : -band.floorCents;
  return value(size, worstMove) + fee(size, widest, feeBps);
}

/** A position's collateral (its most possible loss) and the pool's reserve (its most possible gain). */
export function openTerms(
  isLong: boolean,
  size: bigint,
  entryCents: bigint,
  band: Band,
) {
  return {
    collateral: value(
      size,
      isLong ? entryCents - band.floorCents : band.capCents - entryCents,
    ),
    reserve: value(
      size,
      isLong ? band.capCents - entryCents : entryCents - band.floorCents,
    ),
  };
}

/** What an open order should do at its fill round, by the contract's rules. */
export function expectedOpen(args: {
  isLong: boolean;
  limitCents: bigint;
  index: bigint | null;
  marketPaused: boolean;
  band: Band;
}): { fill: bigint } | { cancel: string } {
  if (args.index === null) return { cancel: 'no index at the fill round' };
  const price = clamp(args.index, args.band);
  if (args.marketPaused) return { cancel: 'market paused' };
  if (price <= args.band.floorCents || price >= args.band.capCents)
    return { cancel: 'price on a band edge' };
  if (args.isLong ? price > args.limitCents : price < args.limitCents)
    return { cancel: 'price beyond the limit' };
  return { fill: price };
}

/** Gain or loss, close fee and payout when a position closes at exitCents with `funding` owed. */
export function closeAmounts(args: {
  isLong: boolean;
  size: bigint;
  entryCents: bigint;
  exitCents: bigint;
  collateral: bigint;
  funding: bigint;
  feeBps: bigint;
}) {
  const move = args.isLong
    ? args.exitCents - args.entryCents
    : args.entryCents - args.exitCents;
  const pnl = value(args.size, move);
  const closeFee = fee(args.size, args.exitCents, args.feeBps);
  const equity = args.collateral + pnl - args.funding - closeFee;
  return { pnl, fee: closeFee, payout: equity > 0n ? equity : 0n };
}

/**
 * Funding, from the plan's rule: the side with more open MWh pays the pool,
 * every second, maxFunding x (imbalance / total open) cents per MWh per
 * hour. Integrated here in exact fractions per position, so it can be set
 * against the contract's cumulative-index arithmetic.
 */
export class FundingModel {
  /** units owed by each open position, as an exact fraction numerator / DEN */
  private owed = new Map<string, { isLong: boolean; size: bigint; num: bigint }>();
  private last: number;
  private maxCentsPerMwhHour: bigint;
  // size is 1/1000 MWh, a cent is 10,000 units, an hour 3,600 s; SCALE keeps the division exact
  private static readonly SCALE = 10n ** 18n;
  private static readonly DEN = 1000n * 3600n * FundingModel.SCALE;

  constructor(maxCentsPerMwhHour: bigint, start: number) {
    this.maxCentsPerMwhHour = maxCentsPerMwhHour;
    this.last = start;
  }

  /** Accrues to time t. Call before any change to the open positions or the rate. */
  advance(t: number) {
    const dt = BigInt(t - this.last);
    this.last = t;
    if (dt <= 0n) return;
    let longs = 0n;
    let shorts = 0n;
    for (const p of this.owed.values()) {
      if (p.isLong) longs += p.size;
      else shorts += p.size;
    }
    const total = longs + shorts;
    if (total === 0n || longs === shorts) return;
    const skew = longs > shorts ? longs - shorts : shorts - longs;
    const payersLong = longs > shorts;
    for (const p of this.owed.values()) {
      if (p.isLong !== payersLong) continue;
      // size x rate (cents/MWh/h) x dt / 3600 x 10,000 / 1,000, with rate = max x skew / total
      p.num +=
        (p.size * this.maxCentsPerMwhHour * skew * dt * 10_000n * FundingModel.SCALE) /
        total;
    }
  }

  clone(): FundingModel {
    const copy = new FundingModel(this.maxCentsPerMwhHour, this.last);
    for (const [id, p] of this.owed) copy.owed.set(id, { ...p });
    return copy;
  }

  setRate(t: number, maxCentsPerMwhHour: bigint) {
    this.advance(t);
    this.maxCentsPerMwhHour = maxCentsPerMwhHour;
  }

  open(t: number, id: string, isLong: boolean, size: bigint) {
    this.advance(t);
    this.owed.set(id, { isLong, size, num: 0n });
  }

  /** Funding the position owes so far, in collateral units, rounded down. */
  owedUnits(id: string): bigint {
    const p = this.owed.get(id);
    return p ? p.num / FundingModel.DEN : 0n;
  }

  close(t: number, id: string): bigint {
    this.advance(t);
    const units = this.owedUnits(id);
    this.owed.delete(id);
    return units;
  }
}

// ------------------------------------------------------------------ options

/** The most an option can pay per MWh: cap - strike for a call, strike - floor for a put. */
export const maxPayoutCents = (strike: bigint, isCall: boolean, band: Band) =>
  isCall ? band.capCents - strike : strike - band.floorCents;

/** A settled option's payout per MWh from the day's final reading, clamped to the band. */
export function payoffCents(
  reading: bigint,
  strike: bigint,
  isCall: boolean,
  band: Band,
): bigint {
  const s = clamp(reading, band);
  const payoff = isCall ? s - strike : strike - s;
  return payoff > 0n ? payoff : 0n;
}

export interface QuoteCents {
  callAsk: bigint;
  callBid: bigint;
  putAsk: bigint;
  putBid: bigint;
}

/** What an options order should do at the quote version it meets. */
export function expectedOptionFill(args: {
  isBuy: boolean;
  isCall: boolean;
  limitCents: bigint;
  quote: QuoteCents | undefined;
}): { premium: bigint } | { cancel: string } {
  const q = args.quote;
  const premium = !q
    ? 0n
    : args.isBuy
      ? args.isCall
        ? q.callAsk
        : q.putAsk
      : args.isCall
        ? q.callBid
        : q.putBid;
  if (premium === 0n) return { cancel: 'strike not quoted' };
  if (args.isBuy ? premium > args.limitCents : premium < args.limitCents)
    return { cancel: 'premium beyond the limit' };
  return { premium };
}
