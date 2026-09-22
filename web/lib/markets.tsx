'use client';

import * as React from 'react';
import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  parseAbiItem,
  toBytes,
  type Address,
  type Hash,
  type Hex,
} from 'viem';

import {
  binaryMarketAbi,
  gridOracleAbi,
  mockUsdtAbi,
  outcomeTokenAbi,
  xLayerTestnet,
} from '@/lib/contracts';
import { formatPrice } from '@/lib/format';
import { useAddresses } from '@/lib/site-data';

/**
 * Every contract fact the site states - a market's strike, day, metric,
 * status, outcome, prices and trades - is read here from the chain, never
 * typed into copy (design-brief.md §6). The only input that isn't a chain
 * read is the list of market addresses, published from
 * shared/addresses.json by build_feed_data.py's write_addresses().
 */

const client = createPublicClient({ chain: xLayerTestnet, transport: http() });

/** The X Layer testnet RPC rejects eth_getLogs spans over 100 blocks. */
const LOG_WINDOW_BLOCKS = 100n;
/** Past this many windows, history is too long to scan from a browser. */
const MAX_LOG_WINDOWS = 60;
const POLL_MS = 15_000;

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

export interface MarketLive {
  resolved: boolean;
  cancelled: boolean;
  yesWon: boolean;
  priceE18: bigint;
}

export interface Market extends MarketFacts {
  live?: MarketLive;
}

const METRIC_WORDS: Record<
  SettlementMetric,
  { short: string; long: string; hub: 'HB_NORTH' | 'HB_WEST' }
> = {
  ERCOT_HBNORTH_DA_AVG: {
    short: 'North Hub',
    long: "ERCOT North Hub's day-ahead average",
    hub: 'HB_NORTH',
  },
  ERCOT_WEST_NORTH_DA_BASIS: {
    short: 'West–North basis',
    long: 'the ERCOT West–North day-ahead basis',
    hub: 'HB_WEST',
  },
};

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

export function marketName(market: MarketFacts): string {
  return `${METRIC_WORDS[market.metricId].short} above ${strikeLabel(market)} · ${dayLabel(market.dayKey)}`;
}

export function payLine(market: MarketFacts): string {
  const strike = formatPrice(market.threshold, 'MWh', isBasis(market.metricId));
  return `Pays 1 mUSDT per contract if ${METRIC_WORDS[market.metricId].long} settles above ${strike} on ${dayLabel(market.dayKey, true)}.`;
}

export function metricShortName(metricId: SettlementMetric): string {
  return METRIC_WORDS[metricId].short;
}

export function marketHub(market: MarketFacts): 'HB_NORTH' | 'HB_WEST' {
  return METRIC_WORDS[market.metricId].hub;
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

function decodeMetricId(bytes: Hex): SettlementMetric | undefined {
  return METRIC_BY_HASH[bytes.toLowerCase() as Hex];
}

async function readFacts(
  address: Address,
  createTxHash: Hash,
): Promise<MarketFacts> {
  const read = (functionName: string) =>
    client.readContract({ address, abi: binaryMarketAbi, functionName });
  const [metricIdBytes, dayKey, threshold, resolveAfter, yesToken, noToken] =
    await Promise.all([
      read('metricId'),
      read('dayKey'),
      read('threshold'),
      read('resolveAfter'),
      read('yesToken'),
      read('noToken'),
    ]);
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

async function readLive(address: Address): Promise<MarketLive> {
  const read = (functionName: string) =>
    client.readContract({ address, abi: binaryMarketAbi, functionName });
  const [resolved, cancelled, yesWon, priceE18] = await Promise.all([
    read('resolved'),
    read('cancelled'),
    read('yesWon'),
    read('price'),
  ]);
  return {
    resolved: resolved as boolean,
    cancelled: cancelled as boolean,
    yesWon: yesWon as boolean,
    priceE18: priceE18 as bigint,
  };
}

interface MarketsValue {
  /** null while loading; [] when none are listed. */
  markets: Market[] | null;
  error?: string;
  selected?: Market;
  select: (address: Address) => void;
  /** Wall clock for status derivation, advanced by the poll. */
  now: number;
}

const MarketsContext = React.createContext<MarketsValue | null>(null);

export function MarketsProvider({ children }: { children: React.ReactNode }) {
  const addresses = useAddresses();
  const [facts, setFacts] = React.useState<MarketFacts[] | null>(null);
  const [live, setLive] = React.useState<Record<string, MarketLive>>({});
  const [error, setError] = React.useState<string>();
  const [selectedAddress, setSelectedAddress] = React.useState<Address>();
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!addresses) return;
    let cancelled = false;
    const listed = addresses.markets ?? [];
    void Promise.all(
      listed.map((m) =>
        readFacts(getAddress(m.market), m.createTxHash as Hash),
      ),
    )
      .then((result) => {
        // Most recent market day first; the first is selected by default.
        if (!cancelled) setFacts(result.sort((a, b) => b.dayKey - a.dayKey));
      })
      .catch(() => {
        if (!cancelled) setError('Could not read markets from X Layer.');
      });
    return () => {
      cancelled = true;
    };
  }, [addresses]);

  React.useEffect(() => {
    if (!facts || facts.length === 0) return;
    let cancelled = false;
    const poll = () => {
      void Promise.all(facts.map((m) => readLive(m.address)))
        .then((states) => {
          if (cancelled) return;
          setLive(
            Object.fromEntries(
              states.map((state, i) => [facts[i].address, state]),
            ),
          );
          setNow(Date.now());
          setError(undefined);
        })
        .catch(() => {
          if (!cancelled) setError('Could not read market state from X Layer.');
        });
    };
    poll();
    const id = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [facts]);

  const markets = React.useMemo(
    () => facts?.map((m) => ({ ...m, live: live[m.address] })) ?? null,
    [facts, live],
  );

  const value = React.useMemo<MarketsValue>(
    () => ({
      markets,
      error,
      selected:
        markets?.find((m) => m.address === selectedAddress) ?? markets?.[0],
      select: setSelectedAddress,
      now,
    }),
    [markets, error, selectedAddress, now],
  );

  return (
    <MarketsContext.Provider value={value}>{children}</MarketsContext.Provider>
  );
}

export function useMarkets(): MarketsValue {
  const value = React.useContext(MarketsContext);
  if (!value)
    throw new Error('useMarkets must be used within MarketsProvider.');
  return value;
}

export interface OracleReading {
  value: number;
  sourceHash: Hex;
  publishedAt: number;
  finalized: boolean;
}

/** GridOracle.getReading() never reverts; publishedAt 0 means nothing published. */
export function useOracleReading(
  metricIdBytes?: Hex,
  dayKey?: number,
): OracleReading | null | undefined {
  const addresses = useAddresses();
  const [reading, setReading] = React.useState<OracleReading | null>();

  React.useEffect(() => {
    if (!addresses || !metricIdBytes || !dayKey) return;
    let cancelled = false;
    void client
      .readContract({
        address: getAddress(addresses.GridOracle),
        abi: gridOracleAbi,
        functionName: 'getReading',
        args: [metricIdBytes, dayKey],
      })
      .then((result) => {
        if (cancelled) return;
        const r = result as {
          value: bigint;
          sourceHash: Hex;
          publishedAt: bigint;
          finalized: boolean;
        };
        setReading(
          r.publishedAt === 0n
            ? null
            : {
                value: Number(r.value),
                sourceHash: r.sourceHash,
                publishedAt: Number(r.publishedAt),
                finalized: r.finalized,
              },
        );
      })
      .catch(() => {
        if (!cancelled) setReading(null);
      });
    return () => {
      cancelled = true;
    };
  }, [addresses, metricIdBytes, dayKey]);

  return reading;
}

export interface Trade {
  txHash: Hash;
  blockNumber: bigint;
  account: Address;
  yesForNo: boolean;
  amountIn: bigint;
  amountOut: bigint;
}

export type TradeHistory =
  | { state: 'loading' }
  | { state: 'ready'; trades: Trade[] }
  | { state: 'too-long' }
  | { state: 'error' };

const swappedEvent = parseAbiItem(
  'event Swapped(address indexed account, bool indexed yesForNo, uint256 amountIn, uint256 amountOut)',
);

/**
 * Every Swapped event the market has emitted. Swaps revert once
 * block.timestamp >= resolveAfter, so the scan runs from the creation block
 * to the first block at or past resolveAfter (or the chain head while
 * trading is open) - a bounded range, not the whole chain.
 */
async function scanTrades(
  market: Pick<MarketFacts, 'address' | 'createTxHash' | 'resolveAfter'>,
): Promise<TradeHistory> {
  const receipt = await client.getTransactionReceipt({
    hash: market.createTxHash,
  });
  const head = await client.getBlockNumber();
  const trades: Trade[] = [];
  let from = receipt.blockNumber;
  for (let window = 0; from <= head; window += 1) {
    if (window >= MAX_LOG_WINDOWS) return { state: 'too-long' };
    const to =
      from + LOG_WINDOW_BLOCKS - 1n < head
        ? from + LOG_WINDOW_BLOCKS - 1n
        : head;
    const [logs, endBlock] = await Promise.all([
      client.getLogs({
        address: market.address,
        event: swappedEvent,
        fromBlock: from,
        toBlock: to,
      }),
      client.getBlock({ blockNumber: to }),
    ]);
    for (const log of logs) {
      trades.push({
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        account: log.args.account as Address,
        yesForNo: log.args.yesForNo as boolean,
        amountIn: log.args.amountIn as bigint,
        amountOut: log.args.amountOut as bigint,
      });
    }
    if (Number(endBlock.timestamp) >= market.resolveAfter) break;
    from = to + 1n;
  }
  return { state: 'ready', trades: trades.reverse() };
}

export function useTradeHistory(market?: Market): TradeHistory {
  const [history, setHistory] = React.useState<{
    key?: string;
    value: TradeHistory;
  }>({
    value: { state: 'loading' },
  });
  const address = market?.address;
  const createTxHash = market?.createTxHash;
  const resolveAfter = market?.resolveAfter;
  // Every swap moves price(), so a price change is the signal to rescan.
  const price = market?.live?.priceE18.toString();
  const key = address ? `${address}:${price}` : undefined;

  React.useEffect(() => {
    if (!address || !createTxHash || resolveAfter === undefined) return;
    let cancelled = false;
    void scanTrades({ address, createTxHash, resolveAfter })
      .then((value) => {
        if (!cancelled) setHistory({ key: `${address}:${price}`, value });
      })
      .catch(() => {
        if (!cancelled)
          setHistory({ key: `${address}:${price}`, value: { state: 'error' } });
      });
    return () => {
      cancelled = true;
    };
  }, [address, createTxHash, resolveAfter, price]);

  return history.key === key ? history.value : { state: 'loading' };
}

export interface Balances {
  collateral: bigint;
  yes: bigint;
  no: bigint;
}

export function useBalances(
  account?: Address,
  market?: Market,
): Balances | undefined {
  const addresses = useAddresses();
  const [balances, setBalances] = React.useState<{
    key?: string;
    value?: Balances;
  }>({});
  const collateral = addresses?.MockUSDT;
  const yesToken = market?.yesToken;
  const noToken = market?.noToken;
  const price = market?.live?.priceE18.toString();
  const key =
    account && yesToken ? `${account}:${yesToken}:${price}` : undefined;

  React.useEffect(() => {
    if (!account || !collateral || !yesToken || !noToken) return;
    let cancelled = false;
    const balanceOf = (address: Address) =>
      client.readContract({
        address,
        abi:
          address === yesToken || address === noToken
            ? outcomeTokenAbi
            : mockUsdtAbi,
        functionName: 'balanceOf',
        args: [account],
      }) as Promise<bigint>;
    void Promise.all([
      balanceOf(getAddress(collateral)),
      balanceOf(yesToken),
      balanceOf(noToken),
    ])
      .then(([collateralBalance, yes, no]) => {
        if (!cancelled) {
          setBalances({
            key: `${account}:${yesToken}:${price}`,
            value: { collateral: collateralBalance, yes, no },
          });
        }
      })
      .catch(() => {
        if (!cancelled) setBalances({});
      });
    return () => {
      cancelled = true;
    };
  }, [account, collateral, yesToken, noToken, price]);

  return balances.key === key ? balances.value : undefined;
}
