/**
 * Pure helpers for the settlement-price chart's daily candles: one candle
 * per published day, built by build_feed_data.py from that day's 24 hourly
 * day-ahead prices (the same raw files its daily price hashes). No React,
 * so they are tested directly.
 */

/** One day's hourly prices, in cents: open at hour 0, close at hour 23. */
export interface PriceCandle {
  dayKey: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** The daily average, the value markets settle on. */
  average: number;
}

/** A day between the first and last published day that has no candle. */
export interface SkippedCandle {
  dayKey: number;
  reason: string;
}

/** web/public/data/price-candles.json, written by write_price_candles(). */
export interface PriceCandles {
  metricId: string;
  candles: PriceCandle[];
  skipped: SkippedCandle[];
}

/** Up when the day closed above its open, down when below, flat when equal. */
export function candleDirection(candle: Pick<PriceCandle, 'open' | 'close'>): 'up' | 'down' | 'flat' {
  if (candle.close > candle.open) return 'up';
  if (candle.close < candle.open) return 'down';
  return 'flat';
}

/** Skipped days inside [firstDayKey, lastDayKey], the range on screen. */
export function skippedInRange(
  skipped: readonly SkippedCandle[],
  firstDayKey: number,
  lastDayKey: number,
): number {
  return skipped.filter((day) => day.dayKey >= firstDayKey && day.dayKey <= lastDayKey).length;
}

/**
 * Where the open and close sit inside a candle drawn from `top` (the high)
 * to `top + height` (the low), in px, by linear interpolation on the
 * candle's own prices - the same mapping as the chart's y scale.
 */
export function bodyEdges(
  candle: Pick<PriceCandle, 'open' | 'high' | 'low' | 'close'>,
  top: number,
  height: number,
): { top: number; bottom: number } {
  const span = candle.high - candle.low;
  const at = (cents: number) => (span === 0 ? top : top + ((candle.high - cents) / span) * height);
  const open = at(candle.open);
  const close = at(candle.close);
  return { top: Math.min(open, close), bottom: Math.max(open, close) };
}

/** How far above the highest average or strike the price scale reaches. */
export const SCALE_HEADROOM = 1.5;

/**
 * The top of the settlement chart's price scale, in the values' own unit:
 * the highest high when it fits within SCALE_HEADROOM of the highest daily
 * average or strike, otherwise that cap. One afternoon spike can be many
 * times the day's average; scaling to it would press every strike and
 * average into the bottom of the chart. A wick past the cap is drawn to the
 * top edge and marked, and its tooltip still gives the real high.
 */
export function scaleTop(anchors: readonly number[], highs: readonly number[]): number {
  const anchor = Math.max(...anchors);
  const high = Math.max(anchor, ...highs);
  return anchor > 0 ? Math.min(high, anchor * SCALE_HEADROOM) : high;
}
