import { formatUnits } from 'viem';

export function formatToken(value: bigint): string {
  return Number(formatUnits(value, 6)).toLocaleString('en-US', {
    maximumFractionDigits: 2,
  });
}

/** Tailwind utility that keeps digit widths equal so numeric columns align. */
export const TABULAR_NUMS = 'tabular-nums';

/**
 * Dollar amount from integer cents, e.g. -1032 -> "-$10.32", 474 -> "$4.74".
 * `unit` appends a "/unit" suffix (e.g. "MWh"). `showPlus` shows "+" on a
 * positive value — only correct for a signed spread (e.g. the West-North
 * basis); a price level (e.g. North Hub, the load-weighted index) shows no
 * sign when positive, per shared/metrics.md's per-metric unit sections.
 */
export function formatPrice(cents: number, unit?: string, showPlus = false): string {
  const dollars = cents / 100;
  const sign = dollars < 0 ? '-' : dollars > 0 && showPlus ? '+' : '';
  const formatted = Math.abs(dollars).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${formatted}${unit ? `/${unit}` : ''}`;
}

/** Fraction (0-1) as a percentage string, e.g. 0.5 -> "50.0%". */
export function formatPercent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/**
 * Plain integer count with a unit label, e.g. formatCount(12, 'intervals')
 * -> "12 intervals". For metrics that are counts, not scaled currency —
 * per shared/metrics.md, ERCOT_HBWEST_NEG_INTERVALS is "plain integer
 * count, no scaling," unlike the three USD/MWh x100 metrics.
 */
export function formatCount(value: number, unit: string): string {
  return `${value} ${unit}`;
}
