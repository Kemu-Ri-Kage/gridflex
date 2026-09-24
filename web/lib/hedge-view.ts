import {
  dailyMwh,
  ladder,
  scenarios,
  yesCostFor,
  type HedgeScenario,
} from './hedge.ts';

/**
 * What the hedge calculator on /trade shows, derived from its inputs and
 * the markets trading on the chosen day: the ladder's rows with an
 * indicative cost and the amount "Load in ticket" types, the total, and
 * the scenario table. The maths is lib/hedge.ts; this is the rounding,
 * sorting and the price set. No React, so it is tested directly.
 */

/** Settlement prices every scenario table shows, besides the strikes and the protected price. */
export const SCENARIO_PRICES = [60, 80, 100] as const;

/** A market trading on the chosen day, as the calculator needs it. */
export interface HedgeMarket {
  address: string;
  /** Strike in $/MWh. */
  strike: number;
  /** The pool's YES and NO in 6-decimal units; undefined until read. */
  yesReserve?: bigint;
  noReserve?: bigint;
}

export interface HedgeRow {
  address: string;
  strike: number;
  tokens: number;
  /** Indicative cost rounded up to the cent, in whole cents; undefined until the pool is read. */
  costCents?: number;
  /** The same cost as typed into the ticket's amount field, e.g. "1234.57". */
  amount?: string;
}

export interface HedgeView {
  mwh: number;
  rows: HedgeRow[];
  /** The rows' costs added up, in whole cents; undefined while any pool is unread. */
  totalCents?: number;
  scenarios: HedgeScenario[];
  /** Why there is no ladder: no load, or nothing to protect below the protected price. */
  problem?: 'load' | 'protect';
}

/** A typed input as a number, or 0 when it's blank, not a number or not above 0. */
export function inputNumber(text: string): number {
  const value = Number(text);
  return text.trim() !== '' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 6-decimal token units as whole tokens. */
export function wholeTokens(units: bigint): number {
  return Number(units) / 1e6;
}

/**
 * A cost rounded up to the cent, in whole cents, so the amount loaded
 * into the ticket buys at least the rung's tokens at the indicative price.
 * The toFixed drops float noise first: 12.3 x 100 is 1230.0000000000002,
 * which would otherwise round up to 1231.
 */
export function costCents(cost: number): number {
  return Math.ceil(Number((cost * 100).toFixed(6)));
}

/** Whole cents as the ticket's amount field takes them: 123457 -> "1234.57". */
export function centsAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** The scenario table's prices: each strike, the protected price and $60/$80/$100, deduped and sorted. */
export function scenarioPrices(strikes: readonly number[], protectTo: number): number[] {
  return [...new Set([...strikes, protectTo, ...SCENARIO_PRICES])]
    .filter((price) => price > 0)
    .toSorted((a, b) => a - b);
}

/** The ladder, its costs and its scenarios for a load of `mw` for `hours` a day, protected up to `protectTo` $/MWh. */
export function hedgeView(
  mw: number,
  hours: number,
  protectTo: number,
  markets: readonly HedgeMarket[],
): HedgeView {
  const mwh = dailyMwh(mw, hours);
  if (mwh === 0) return { mwh, rows: [], scenarios: [], problem: 'load' };
  const rungs = ladder(mwh, markets.map((market) => market.strike), protectTo);
  if (rungs.length === 0) return { mwh, rows: [], scenarios: [], problem: 'protect' };

  // ladder() keeps one rung per strike; the first market on it is the one to buy.
  const byStrike = new Map<number, HedgeMarket>();
  for (const market of markets) if (!byStrike.has(market.strike)) byStrike.set(market.strike, market);
  const rows = rungs.flatMap(({ strike, tokens }) => {
    const market = byStrike.get(strike);
    return market ? [hedgeRow(market, tokens)] : [];
  });
  const costs = rows.map((row) => row.costCents);
  const totalCents = costs.every((cents): cents is number => cents !== undefined)
    ? costs.reduce((sum, cents) => sum + cents, 0)
    : undefined;
  const prices = scenarioPrices(markets.map((market) => market.strike), protectTo);
  return { mwh, rows, totalCents, scenarios: scenarios(mwh, rungs, prices) };
}

/** One rung's row, costed from its pool once both sides are read and non-empty. */
function hedgeRow(market: HedgeMarket, tokens: number): HedgeRow {
  const row: HedgeRow = { address: market.address, strike: market.strike, tokens };
  if (!market.yesReserve || !market.noReserve) return row;
  const cost = yesCostFor(tokens, wholeTokens(market.yesReserve), wholeTokens(market.noReserve));
  if (!(cost > 0)) return row;
  const cents = costCents(cost);
  return { ...row, costCents: cents, amount: centsAmount(cents) };
}

/** Each day with a market trading, earliest first, with the first of its markets in the list's order. */
export function tradingDays<T extends { dayKey: number }>(markets: readonly T[]): T[] {
  const first = new Map<number, T>();
  for (const market of markets) if (!first.has(market.dayKey)) first.set(market.dayKey, market);
  return [...first.values()].toSorted((a, b) => a.dayKey - b.dayKey);
}
