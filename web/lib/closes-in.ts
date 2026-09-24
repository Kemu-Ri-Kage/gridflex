/**
 * How long a market has left to trade, for the landing page's contract
 * cards: "6d 18h", "3h 12m", "12m", or null once trading has closed. From
 * the market's resolveAfter, the moment BinaryMarket starts refusing buys
 * and swaps. No React, so it is tested directly.
 */
export function closesIn(resolveAfterSeconds: number, nowMs: number): string | null {
  const left = Math.floor(resolveAfterSeconds - nowMs / 1000);
  if (left <= 0) return null;
  const days = Math.floor(left / 86_400);
  const hours = Math.floor((left % 86_400) / 3_600);
  const minutes = Math.floor((left % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}
