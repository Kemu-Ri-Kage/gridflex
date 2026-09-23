import summaryJson from '@/lib/generated/price-summary.json';

/**
 * The landing page's lead, written by build_feed_data.py's
 * write_price_summary() into lib/generated/: the latest day's cheapest and dearest hour, the
 * normal range of daily prices, and the peak day. Prices are cents per
 * MWh, the same x100 scale as oracle readings.
 *
 * Imported at build time rather than fetched (nothing requests it by URL,
 * so it isn't in public/), so the hero headline renders
 * in its final text on first paint - no layout shift, nothing for the
 * word-by-word reveal to wait on (design-brief.md §13).
 */
export interface PriceHour {
  /** Hour start in Central time, "HH:MM". */
  hourStartCentral: string;
  hourStartUtc: number;
  value: number;
}

export interface PriceSummary {
  latestDay: {
    dayKey: number;
    marketDay: string;
    value: number;
    cheapest: PriceHour;
    dearest: PriceHour;
  };
  range: {
    days: number;
    firstDayKey: number;
    lastDayKey: number;
    /** 10th and 90th percentile of daily prices: the middle 80% of days. */
    low: number;
    high: number;
    median: number;
    peak: { dayKey: number; value: number; timesMedian: number };
  };
}

export const priceSummary: PriceSummary = summaryJson;

/** "09:00" -> "9am", "19:00" -> "7pm". */
export function hourLabel(hourStartCentral: string): string {
  const hour = Number(hourStartCentral.slice(0, 2));
  if (hour === 0) return '12am';
  if (hour === 12) return '12pm';
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}
