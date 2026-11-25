/**
 * Hedge calculator v2 (GRIDFLEX Trading Platform Plan, "Hedge calculator
 * v2"): the user enters the power to hedge and a goal, and gets a trade in
 * either market, what it costs up front, and the day's energy cost (or
 * revenue) at a range of prices, with and without it.
 *
 *   goal "lock"  buyer: long the perpetual    producer: short the perpetual
 *   goal "cap"   buyer: calls at the cap      producer: puts at the floor
 *
 * Both markets settle on the band-clamped price, so beyond the band the
 * hedge stops paying more: the scenarios show that. Prices are $/MWh,
 * amounts dollars; fees and funding are left out (shown on the ticket).
 * No React here, so it is tested directly.
 */

import type { Band } from './option-pricing.ts';

export type Role = 'buyer' | 'producer';

export interface Load {
  role: Role;
  /** Megawatts used (buyer) or produced (producer). */
  mw: number;
  /** Hours a day at that level, 1-24. */
  hoursPerDay: number;
  /** Share of the energy to hedge, 0-1. */
  share: number;
}

/** MWh a day, and the MWh to hedge. */
export function dailyEnergy(load: Load): { mwh: number; hedgedMwh: number } {
  const valid =
    load.mw > 0 &&
    load.hoursPerDay > 0 &&
    load.hoursPerDay <= 24 &&
    load.share >= 0 &&
    load.share <= 1;
  if (!valid) return { mwh: 0, hedgedMwh: 0 };
  const mwh = load.mw * load.hoursPerDay;
  return { mwh, hedgedMwh: mwh * load.share };
}

function clamp(price: number, band: Band): number {
  return Math.min(Math.max(price, band.floor), band.cap);
}

export interface PerpHedge {
  kind: 'perp';
  side: 'long' | 'short';
  sizeMwh: number;
  entryPrice: number;
  /** What the position posts: its largest possible loss inside the band. */
  collateral: number;
}

/** Lock a price: a buyer goes long, a producer short, for the hedged MWh. */
export function perpHedge(
  load: Load,
  entryPrice: number,
  band: Band,
): PerpHedge {
  const { hedgedMwh } = dailyEnergy(load);
  const side = load.role === 'buyer' ? 'long' : 'short';
  const entry = clamp(entryPrice, band);
  const worstMove = side === 'long' ? entry - band.floor : band.cap - entry;
  return {
    kind: 'perp',
    side,
    sizeMwh: hedgedMwh,
    entryPrice: entry,
    collateral: hedgedMwh * worstMove,
  };
}

export interface OptionHedge {
  kind: 'option';
  type: 'call' | 'put';
  strike: number;
  sizeMwh: number;
  premiumPerMwh: number;
  /** Premium for one day's options. */
  premium: number;
  /**
   * A buyer's highest price per MWh on the hedged part (strike + premium);
   * a producer's lowest (strike - premium).
   */
  effectivePrice: number;
}

/** Cap a cost (buyer: calls) or set a floor (producer: puts) at `strike`, for one day. */
export function optionHedge(
  load: Load,
  strike: number,
  premiumPerMwh: number,
): OptionHedge {
  const { hedgedMwh } = dailyEnergy(load);
  const type = load.role === 'buyer' ? 'call' : 'put';
  return {
    kind: 'option',
    type,
    strike,
    sizeMwh: hedgedMwh,
    premiumPerMwh,
    premium: hedgedMwh * premiumPerMwh,
    effectivePrice:
      type === 'call' ? strike + premiumPerMwh : strike - premiumPerMwh,
  };
}

/** What the hedge pays (positive) or costs (negative) when the day settles at `price`. */
export function hedgePayoff(
  hedge: PerpHedge | OptionHedge,
  price: number,
  band: Band,
): number {
  const settled = clamp(price, band);
  if (hedge.kind === 'perp') {
    const move = settled - hedge.entryPrice;
    return hedge.sizeMwh * (hedge.side === 'long' ? move : -move);
  }
  const payoff =
    hedge.type === 'call'
      ? Math.max(settled - hedge.strike, 0)
      : Math.max(hedge.strike - settled, 0);
  return hedge.sizeMwh * payoff - hedge.premium;
}

export interface Scenario {
  price: number;
  /** A buyer's energy cost or a producer's revenue for the day, without the hedge. */
  unhedged: number;
  /** The same with the hedge's payoff: cost minus payoff, or revenue plus payoff. */
  hedged: number;
}

/** The day's cost (buyer) or revenue (producer) at each price, with and without the hedge. */
export function scenarios(
  load: Load,
  hedge: PerpHedge | OptionHedge,
  prices: readonly number[],
  band: Band,
): Scenario[] {
  const { mwh } = dailyEnergy(load);
  return prices.map((price) => {
    const unhedged = mwh * price;
    const payoff = hedgePayoff(hedge, price, band);
    return {
      price,
      unhedged,
      hedged: load.role === 'buyer' ? unhedged - payoff : unhedged + payoff,
    };
  });
}

/** Prices worth showing: from a cheap day through a scarcity spike past the band. */
export const SCENARIO_PRICES = [-20, 0, 25, 45, 75, 150, 300, 1000] as const;
