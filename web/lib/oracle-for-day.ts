/**
 * Which GridOracle holds a day's reading. A market names its oracle when it
 * is created, so once the oracle is replaced (shared/oracle-v2.md) the days
 * up to the old one's last day stay there: reading them from the current
 * oracle would show a settled day as never published.
 */
export interface OracleAddresses {
  GridOracle: string;
  /** Replaced oracles, each with the last day it holds (build_feed_data.py write_addresses). */
  retiredOracles?: { address: string; lastDayKey: number }[];
}

export function oracleForDay(addresses: OracleAddresses, dayKey: number): string {
  let holder: { address: string; lastDayKey: number } | undefined;
  for (const retired of addresses.retiredOracles ?? []) {
    if (dayKey <= retired.lastDayKey && (!holder || retired.lastDayKey < holder.lastDayKey)) {
      holder = retired;
    }
  }
  return holder ? holder.address : addresses.GridOracle;
}
