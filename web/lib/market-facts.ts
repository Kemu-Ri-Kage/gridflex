import { keccak256, toBytes, type Address, type Hash, type Hex } from 'viem';

import { formatPrice } from './format.ts';
import type { MarketLive } from './market-live.ts';

/**
 * A market's contract facts and the words the site builds from them, with
 * no React and no RPC client: lib/markets.tsx reads them for the pages and
 * the price API (lib/price-api.ts) for its routes, so both name, date and
 * classify a market the same way.
 */

export type SettlementMetric =
  | 'ERCOT_HBNORTH_DA_AVG'
  | 'ERCOT_WEST_NORTH_DA_BASIS';

export type MarketStatus = 'trading' | 'awaiting' | 'resolved' | 'cancelled';

export interface MarketFacts {
  address: Address;
  createTxHash: Hash;
  metricId: SettlementMetric;
  metricIdBytes: Hex;
  dayKey: number;
  /** Strike in cents, same x100 scale as oracle readings. */
  threshold: number;
  resolveAfter: number;
  yesToken: Address;
  noToken: Address;
}

export interface Market extends MarketFacts {
  live?: MarketLive;
}

/**
 * Display words per settlement metric (design-brief.md §5 dictionary). The
 * basis entry exists only so its markets decode; the public site lists
 * PUBLIC_METRIC's markets alone and never shows the basis.
 */
const METRIC_WORDS: Record<SettlementMetric, { short: string; long: string }> = {
  ERCOT_HBNORTH_DA_AVG: { short: 'Texas power', long: 'the Texas power price' },
  ERCOT_WEST_NORTH_DA_BASIS: { short: 'Basis', long: 'the basis' },
};

/** The one product the public site lists (design-brief.md §5). */
export const PUBLIC_METRIC: SettlementMetric = 'ERCOT_HBNORTH_DA_AVG';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** dayKey is a YYYYMMDD label, never a timestamp - slice it, don't convert it. */
export function dayLabel(dayKey: number, withYear = false): string {
  const s = String(dayKey);
  const day = Number(s.slice(6, 8));
  const month = MONTHS[Number(s.slice(4, 6)) - 1];
  return withYear ? `${day} ${month} ${s.slice(0, 4)}` : `${day} ${month}`;
}

function isBasis(metricId: SettlementMetric): boolean {
  return metricId === 'ERCOT_WEST_NORTH_DA_BASIS';
}

/** "$30", "+$4", "$0" - the `+` sign only ever on the basis spread (§5). */
export function strikeLabel(
  market: Pick<MarketFacts, 'metricId' | 'threshold'>,
): string {
  const text = formatPrice(
    market.threshold,
    undefined,
    isBasis(market.metricId),
  );
  return text.endsWith('.00') ? text.slice(0, -3) : text;
}

/** The product as a question: "Will Texas power cost more than $30 on 8 Sep?" */
export function marketName(market: MarketFacts): string {
  return `Will ${METRIC_WORDS[market.metricId].short} cost more than ${strikeLabel(market)} on ${dayLabel(market.dayKey)}?`;
}

export function payLine(market: MarketFacts): string {
  const strike = formatPrice(market.threshold, 'MWh', isBasis(market.metricId));
  return `Pays 1 mUSDT per YES if ${METRIC_WORDS[market.metricId].long} for ${dayLabel(market.dayKey, true)} settles above ${strike}.`;
}

export function metricShortName(metricId: SettlementMetric): string {
  return METRIC_WORDS[metricId].short;
}

/** Strike as a price level on the hub chart - only meaningful for a hub price, not a spread. */
export function chartStrikeDollars(market: MarketFacts): number | undefined {
  return isBasis(market.metricId) ? undefined : market.threshold / 100;
}

export function marketStatus(
  market: Market,
  nowMs: number,
): MarketStatus | undefined {
  if (!market.live) return undefined;
  if (market.live.resolved) return 'resolved';
  if (market.live.cancelled) return 'cancelled';
  return nowMs < market.resolveAfter * 1000 ? 'trading' : 'awaiting';
}

export function statusLabel(market: Market, nowMs: number): string | undefined {
  switch (marketStatus(market, nowMs)) {
    case 'trading':
      return 'Trading';
    case 'awaiting':
      return 'Awaiting resolution';
    case 'resolved':
      return `Resolved · ${market.live?.yesWon ? 'YES' : 'NO'}`;
    case 'cancelled':
      return 'Cancelled';
    default:
      return undefined;
  }
}

export function formatUtc(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${hh}:${mm} UTC`;
}

/** On chain, metricId is keccak256 of the name (shared/oracle-interface.md). */
const METRIC_BY_HASH = Object.fromEntries(
  (Object.keys(METRIC_WORDS) as SettlementMetric[]).map((name) => [
    keccak256(toBytes(name)),
    name,
  ]),
) as Record<Hex, SettlementMetric>;

export function decodeMetricId(bytes: Hex): SettlementMetric | undefined {
  return METRIC_BY_HASH[bytes.toLowerCase() as Hex];
}

/** The BinaryMarket reads that never change after creation, in factsFrom()'s order. */
export const FACT_FIELDS = [
  'metricId',
  'dayKey',
  'threshold',
  'resolveAfter',
  'yesToken',
  'noToken',
] as const;

export type FactField = (typeof FACT_FIELDS)[number];

/** A market's facts from the values of FACT_FIELDS, read in that order. */
export function factsFrom(
  address: Address,
  createTxHash: Hash,
  values: readonly unknown[],
): MarketFacts {
  const [metricIdBytes, dayKey, threshold, resolveAfter, yesToken, noToken] = values;
  const metricId = decodeMetricId(metricIdBytes as Hex);
  if (!metricId) throw new Error(`Unknown settlement metric on ${address}.`);
  return {
    address,
    createTxHash,
    metricId,
    metricIdBytes: metricIdBytes as Hex,
    dayKey: Number(dayKey),
    threshold: Number(threshold),
    resolveAfter: Number(resolveAfter),
    yesToken: yesToken as Address,
    noToken: noToken as Address,
  };
}

/** Reads one market's facts, one call per field, through `read`. */
export async function readFacts(
  read: (functionName: FactField) => Promise<unknown>,
  address: Address,
  createTxHash: Hash,
): Promise<MarketFacts> {
  return factsFrom(address, createTxHash, await Promise.all(FACT_FIELDS.map(read)));
}
