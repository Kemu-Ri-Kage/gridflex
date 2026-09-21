import { formatUnits } from 'viem';

export function formatToken(value: bigint): string {
  return Number(formatUnits(value, 6)).toLocaleString('en-US', {
    maximumFractionDigits: 2,
  });
}

/** Tailwind utility that keeps digit widths equal so numeric columns align. */
export const TABULAR_NUMS = 'tabular-nums';

/**
 * Signed dollar amount from integer cents, e.g. -1032 -> "-$10.32".
 * `unit` appends a "/unit" suffix (e.g. "MWh") when given.
 */
export function formatPrice(cents: number, unit?: string): string {
  const dollars = cents / 100;
  const sign = dollars < 0 ? '-' : dollars > 0 ? '+' : '';
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
