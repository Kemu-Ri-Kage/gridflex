/**
 * Plain-English market copy for the /trade instrument bar.
 *
 * Values here (strike, dayKey, hub) come from shared/demo-markets.md market
 * #1 -- the only demo market with a real, already-published oracle reading
 * to show. No BinaryMarket is deployed for it yet (shared/addresses.json:
 * BinaryMarket/YesToken/NoToken are all empty), so this is editorial market
 * design copy, not a value read from a contract -- the trade panel below it
 * already discloses "Demo preview" for that reason (web3-provider.tsx's
 * `contractsConfigured`), and nothing here should claim otherwise.
 */
export const FEATURED_MARKET = {
  metricId: 'ERCOT_HBNORTH_DA_AVG' as const,
  hub: 'HB_NORTH' as const,
  dayKey: 20260908,
  marketDay: '2026-09-08',
  marketDayLabel: '8 Sep 2026',
  strikeDollars: 30,
  name: 'North Hub above $30 · 8 Sep',
  description:
    "Pays $1 per contract if ERCOT North Hub's day-ahead average settles above $30/MWh on 8 Sep 2026. Cash-settled in MockUSDT on X Layer testnet.",
};
