/**
 * Hedging a power bill with YES tokens: how many to hold on each strike,
 * what they pay at a given price, and what they cost from a market's pool.
 * Shared by the hedge calculator on /trade and the price API's
 * /hedge-quote, so both size a hedge the same way. No React, so it is
 * tested directly.
 *
 * A YES pays 1 mUSDT when the day's average price settles above its
 * strike. A buyer's extra cost above a strike grows with every dollar, so
 * one strike alone pays a fixed amount however high the price goes. A
 * ladder of strikes, each holding the MWh times the gap to the next rung,
 * pays out in steps that follow the extra cost up to the top of the
 * ladder: the digital-option strip that approximates a capped call.
 */

/** MWh a load uses in a day: `mw` megawatts for `hours` hours. */
export function dailyMwh(mw: number, hours = 24): number {
  if (!(mw > 0) || !(hours > 0) || hours > 24) return 0;
  return mw * hours;
}

/** One rung of a ladder: a strike in $/MWh and the YES tokens held on it. */
export interface LadderRung {
  strike: number;
  tokens: number;
}

/**
 * The YES tokens to hold on each strike so the ladder pays the extra cost
 * of `mwh` above the lowest strike, up to `protectTo` $/MWh. Rung i holds
 * mwh x (next strike - strike i), the last rung mwh x (protectTo - strike).
 * Strikes at or above `protectTo`, and duplicates, are left out.
 */
export function ladder(mwh: number, strikes: readonly number[], protectTo: number): LadderRung[] {
  const used = [...new Set(strikes)].filter((strike) => strike < protectTo).toSorted((a, b) => a - b);
  if (!(mwh > 0) || used.length === 0) return [];
  return used.map((strike, i) => {
    const next = i + 1 < used.length ? used[i + 1] : protectTo;
    return { strike, tokens: mwh * (next - strike) };
  });
}

/** What a ladder pays, in mUSDT, when the day settles at `price`: every rung strictly below it. */
export function ladderPayout(rungs: readonly LadderRung[], price: number): number {
  return rungs.filter((rung) => price > rung.strike).reduce((sum, rung) => sum + rung.tokens, 0);
}

/** The extra cost, in dollars, of `mwh` at `price` over paying `from` $/MWh. */
export function extraCost(mwh: number, price: number, from: number): number {
  return mwh * Math.max(0, price - from);
}

/** One row of a scenario table: a settlement price, the extra cost, and what the ladder pays. */
export interface HedgeScenario {
  price: number;
  extraCost: number;
  payout: number;
  /** payout / extraCost, or null when there is no extra cost. */
  covered: number | null;
}

/** The extra cost over the lowest strike and the ladder's payout at each price. */
export function scenarios(mwh: number, rungs: readonly LadderRung[], prices: readonly number[]): HedgeScenario[] {
  const from = rungs.length ? rungs[0].strike : 0;
  return prices.map((price) => {
    const cost = extraCost(mwh, price, from);
    const payout = ladderPayout(rungs, price);
    return { price, extraCost: cost, payout, covered: cost > 0 ? payout / cost : null };
  });
}

/**
 * The mUSDT a buy of `tokens` YES costs from a pool holding `yesReserve`
 * YES and `noReserve` NO, both in whole tokens. A buy of A mUSDT mints A YES
 * and A NO and swaps the NO for YES through the zero-fee constant-product
 * pool (BinaryMarket.quoteSwap with SWAP_FEE_BPS = 0), so it ends with
 * A + yesReserve x A / (noReserve + A) YES. Solved for A:
 * A^2 + (noReserve + yesReserve - tokens) A - tokens x noReserve = 0.
 * Indicative: the ticket's own quote, read from the contract, is what a buy
 * is sent with.
 */
export function yesCostFor(tokens: number, yesReserve: number, noReserve: number): number {
  if (!(tokens > 0) || !(yesReserve > 0) || !(noReserve > 0)) return 0;
  const b = noReserve + yesReserve - tokens;
  return (-b + Math.sqrt(b * b + 4 * tokens * noReserve)) / 2;
}

/** The YES a buy of `amount` mUSDT returns from the same pool: the inverse of yesCostFor. */
export function yesOutFor(amount: number, yesReserve: number, noReserve: number): number {
  if (!(amount > 0) || !(yesReserve > 0) || !(noReserve > 0)) return 0;
  return amount + (yesReserve * amount) / (noReserve + amount);
}
