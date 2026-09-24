/**
 * Pure helpers for the live price chart's view: which candles a timeframe
 * opens on, how a view carries across a timeframe switch, and the price
 * scale for the candles on screen. No React, so they are tested directly.
 */

import { niceCeil } from './price-candles.ts';

export type Timeframe = '15m' | '1h' | '4h' | '1d' | '1w';

/**
 * Candles a timeframe opens on, counted back from the latest: 2 days of
 * 15m, 2 weeks of 1H, about a month of 4H, about 3 months of 1D, and
 * every week (the 1W file is one year, 55 candles).
 */
export const DEFAULT_BARS: Record<Timeframe, number> = {
  '15m': 2 * 96,
  '1h': 14 * 24,
  '4h': 30 * 6,
  '1d': 90,
  '1w': Number.POSITIVE_INFINITY,
};

/** Fewest candles a carried-over view shows, so a short span on a coarse timeframe isn't one fat bar. */
export const MIN_BARS = 24;

/** A logical range as Lightweight Charts takes it: each bar drawn centred on its index. */
export interface LogicalSpan {
  from: number;
  to: number;
}

/** The last `bars` candles out of `count`. */
export function latestRange(count: number, bars: number): LogicalSpan {
  return { from: Math.max(0, count - bars), to: count - 1 };
}

/**
 * The range a timeframe switch opens on. With no view to keep (the viewer
 * hasn't zoomed or panned), the timeframe's default. Otherwise the same
 * span of time, in unix seconds, found in the new candles: widened
 * leftwards to MIN_BARS, and the default when the span lies outside the
 * new candles entirely (the 15m and 1H files start later than the others).
 */
export function switchRange(
  times: readonly number[],
  defaultBars: number,
  kept: { from: number; to: number } | null,
): LogicalSpan {
  const count = times.length;
  if (!kept || count === 0) return latestRange(count, defaultBars);
  if (kept.to < times[0] || kept.from > times[count - 1]) return latestRange(count, defaultBars);
  // The candle holding each edge: the last one starting at or before it.
  const holding = (t: number) => {
    let index = 0;
    while (index + 1 < count && times[index + 1] <= t) index++;
    return index;
  };
  const last = holding(kept.to);
  const first = Math.min(holding(kept.from), Math.max(0, last - MIN_BARS + 1));
  return { from: first, to: last };
}

/**
 * How far above the typical candle top the scale reaches before it caps.
 * A power price can spike to 20-30x its usual level for a single interval;
 * fitting the scale to that presses every normal candle into the bottom
 * few pixels.
 */
export const LIVE_HEADROOM = 2;

/** The body top most candles on screen stay under, and the body bottom most stay over. */
const TYPICAL_QUANTILE = 0.9;

/**
 * The price range to show for the candles on screen, in dollars, fitted to
 * the typical candle rather than the extremes. The top stops at
 * LIVE_HEADROOM times the typical body top when a high runs past it: the
 * `cap`, rounded to a plain figure, whose cut wicks the renderer marks
 * (`spikes` counts them). The bottom never cuts a price at or above zero:
 * it stops only a negative dip deeper than the typical body range (top
 * minus bottom) below zero, or below the typical body bottom if that is
 * lower - the `floor`, whose dips are counted in `dips`. The real high and
 * low stay in the hover readout. The strike is always inside the range.
 */
export function liveWindow(
  candles: readonly { open: number; high: number; low: number; close: number }[],
  strike?: number,
): { min: number; max: number; cap: number | null; spikes: number; floor: number | null; dips: number } | null {
  if (candles.length === 0) return null;
  const tops = candles.map((c) => Math.max(c.open, c.close)).sort((a, b) => a - b);
  const bottoms = candles.map((c) => Math.min(c.open, c.close)).sort((a, b) => a - b);
  const typicalTop = tops[Math.floor(TYPICAL_QUANTILE * (tops.length - 1))];
  const typicalBottom = bottoms[Math.floor((1 - TYPICAL_QUANTILE) * (bottoms.length - 1))];
  const anchor = Math.max(typicalTop, strike ?? Number.NEGATIVE_INFINITY);
  const high = Math.max(...candles.map((c) => c.high), strike ?? Number.NEGATIVE_INFINITY);
  const low = Math.min(...candles.map((c) => c.low), strike ?? Number.POSITIVE_INFINITY);
  const limit = anchor > 0 ? anchor * LIVE_HEADROOM : high;
  const span = typicalTop - typicalBottom;
  const bottomLimit = Math.min(-span, typicalBottom - span);
  // Caps are stated under the chart, so they are rounded to a plain figure.
  const max = high > limit ? niceCeil(limit) : high;
  const min = low < bottomLimit ? -niceCeil(-bottomLimit) : low;
  const spikes = candles.filter((c) => c.high > max).length;
  const dips = candles.filter((c) => c.low < min).length;
  return {
    min,
    max,
    cap: spikes > 0 ? max : null,
    spikes,
    floor: dips > 0 ? min : null,
    dips,
  };
}
