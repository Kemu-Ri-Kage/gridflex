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

/** The settlement chart's presets: they set the visible range, never filter the data. */
export type RangePreset = '90d' | 'year';

/** Published days the 90-day preset shows. */
export const PRESET_DAYS = 90;

/**
 * The logical range a preset shows out of `count` days: the last 90, or
 * every day for the full year. Lightweight Charts' logical range runs from
 * the first bar's index to the last's, each bar drawn centred on its index.
 */
export function presetRange(count: number, preset: RangePreset): { from: number; to: number } {
  const first = preset === '90d' ? Math.max(0, count - PRESET_DAYS) : 0;
  return { from: first, to: count - 1 };
}

/**
 * The bars on screen for a logical range, clamped to the data. A bar spans
 * half a bar either side of its index, so one whose centre is up to half a
 * bar outside the range still shows.
 */
export function visibleIndices(
  count: number,
  range: { from: number; to: number } | null,
): { first: number; last: number } | null {
  if (count === 0) return null;
  if (!range) return { first: 0, last: count - 1 };
  const first = Math.max(0, Math.ceil(range.from - 0.5));
  const last = Math.min(count - 1, Math.floor(range.to + 0.5));
  return first > last ? null : { first, last };
}

/**
 * The price range to show for the visible days, in dollars: from the lowest
 * low, average or strike up to scaleTop() of the averages and strikes, so
 * the scale refits to what is on screen. `cap` is that top when a visible
 * high runs past it (and is marked), otherwise null; `spikes` counts them.
 * Every listed strike is always inside the range.
 */
export function priceWindow(
  candles: readonly Pick<PriceCandle, 'high' | 'low' | 'average'>[],
  strikes: readonly number[],
): { min: number; max: number; cap: number | null; spikes: number } | null {
  if (candles.length === 0 && strikes.length === 0) return null;
  const averages = candles.map((candle) => candle.average / 100);
  const highs = candles.map((candle) => candle.high / 100);
  const lows = candles.map((candle) => candle.low / 100);
  const top = scaleTop([...averages, ...strikes], highs);
  // A cap is stated under the chart, so it is rounded up to a plain figure.
  const max = top < Math.max(...highs) ? niceCeil(top) : top;
  const spikes = highs.filter((high) => high > max).length;
  return {
    min: Math.min(...lows, ...averages, ...strikes),
    max,
    cap: spikes > 0 ? max : null,
    spikes,
  };
}

/** Rounds up to a 1, 2 or 5 step of about a twentieth of the value: 98.69 -> 100, 1041 -> 1100. */
export function niceCeil(value: number): number {
  if (value <= 0) return value;
  const rough = value / 20;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power;
  return Math.ceil(value / step) * step;
}
