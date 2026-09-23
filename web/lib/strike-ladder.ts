/**
 * Pure helpers for the settlement-price chart on /trade: the listed
 * strikes drawn as a ladder, and how often past days settled above the
 * selected one. No React, so they are tested directly.
 */

interface StrikeMarket {
  address: string;
  dayKey: number;
  /** Strike in cents, the contract's own x100 scale. */
  threshold: number;
}

export interface StrikeLine {
  /** Strike in cents. */
  threshold: number;
  /** Every listed market day at this strike, earliest first. */
  dayKeys: number[];
  /** The selected market's strike. */
  selected: boolean;
}

/**
 * One line per distinct strike, highest first. Markets on different days at
 * the same strike share a line, so a ladder on one day reads as separate
 * lines and a repeated strike doesn't draw on top of itself.
 */
export function strikeLines(
  markets: readonly StrikeMarket[],
  selectedAddress: string | undefined,
): StrikeLine[] {
  const byStrike = new Map<number, StrikeLine>();
  for (const market of markets) {
    const line = byStrike.get(market.threshold) ?? {
      threshold: market.threshold,
      dayKeys: [],
      selected: false,
    };
    if (!line.dayKeys.includes(market.dayKey)) line.dayKeys.push(market.dayKey);
    if (market.address === selectedAddress) line.selected = true;
    byStrike.set(market.threshold, line);
  }
  const lines = [...byStrike.values()];
  for (const line of lines) line.dayKeys.sort((a, b) => a - b);
  return lines.sort((a, b) => b.threshold - a.threshold);
}

/**
 * Label positions (px, top-down) for lines at `ys`, each moved as little as
 * possible so no two labels sit closer than `gap`, and all stay within
 * [top, bottom]. Returned in the same order as `ys`.
 */
export function spreadLabels(ys: readonly number[], gap: number, top: number, bottom: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const placed = order.map(({ y }) => Math.min(Math.max(y, top), bottom));
  for (let k = 1; k < placed.length; k++) {
    placed[k] = Math.max(placed[k], placed[k - 1] + gap);
  }
  // Anything pushed past the bottom is pushed back up, keeping the gap.
  if (placed.length && placed[placed.length - 1] > bottom) {
    placed[placed.length - 1] = bottom;
    for (let k = placed.length - 2; k >= 0; k--) {
      placed[k] = Math.min(placed[k], placed[k + 1] - gap);
    }
  }
  const result = Array.from({ length: ys.length }, () => 0);
  order.forEach(({ i }, k) => {
    result[i] = placed[k];
  });
  return result;
}

interface DailyRecord {
  dayKey: number;
  /** Price in cents, as published. */
  value: number;
}

export interface PastFrequency {
  /** Days whose price was strictly above the strike. */
  above: number;
  /** Published days counted - fewer than asked for if history is short. */
  days: number;
  /** The latest day counted, or null if none. */
  lastDayKey: number | null;
}

/**
 * Of the last `window` published days before `beforeDayKey`, how many
 * settled strictly above `threshold`. Integer cents against integer cents
 * with `>`: the same test BinaryMarket.resolve() applies
 * (`reading.value > threshold`), so a day exactly at the strike counts as
 * not above, as it would settle NO. Days on or after the market's own day
 * are left out, so the count never includes the outcome it sits beside.
 */
export function pastFrequency(
  records: readonly DailyRecord[],
  threshold: number,
  beforeDayKey: number,
  window: number,
): PastFrequency {
  const counted = records
    .filter((record) => record.dayKey < beforeDayKey)
    .toSorted((a, b) => a.dayKey - b.dayKey)
    .slice(-window);
  return {
    above: counted.filter((record) => record.value > threshold).length,
    days: counted.length,
    lastDayKey: counted.length ? counted[counted.length - 1].dayKey : null,
  };
}

/**
 * A y range and round ticks covering every value (dollars): the step is
 * the smallest of 5, 10, 20, 25, 50, 100, 200, 250 or 500 that needs at
 * most `maxTicks` ticks, and the range is padded to whole steps either side.
 */
export function niceScale(values: readonly number[], maxTicks = 8): { domain: [number, number]; ticks: number[] } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500];
  const step =
    steps.find((s) => Math.ceil(max / s) - Math.floor(min / s) + 1 <= maxTicks) ?? steps[steps.length - 1];
  const low = Math.floor(min / step) * step;
  const high = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = low; t <= high; t += step) ticks.push(t);
  return { domain: [low, high], ticks };
}
