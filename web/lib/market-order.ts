/**
 * The order of the market list: most recent market day first, and within a
 * day the highest strike first, so a strike ladder reads top to bottom
 * ($45 above $40 on 30 September). The first market is selected by default.
 */
export function compareMarkets(
  a: { dayKey: number; threshold: number },
  b: { dayKey: number; threshold: number },
): number {
  return b.dayKey - a.dayKey || b.threshold - a.threshold;
}
