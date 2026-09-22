'use client';

import * as React from 'react';
import {
  createPublicClient,
  getAddress,
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
  xLayerTransport,
} from '@/lib/contracts';
import { formatPrice } from '@/lib/format';
import {
  buildLedger,
  findChangeBlocks,
  swapIsBuyLeg,
  type Ledger,
  type PositionEvent,
  type UndeterminedReason,
} from '@/lib/position';
import {
  keepSettled,
  readMarketsLive,
  type LiveRead,
  type MarketLive,
} from '@/lib/market-live';
import { useAddresses } from '@/lib/site-data';

export type { MarketLive } from '@/lib/market-live';

/**
 * Every contract fact the site states - a market's strike, day, metric,
 * status, outcome, prices and trades - is read here from the chain, never
 * typed into copy (design-brief.md §6). The only input that isn't a chain
 * read is the list of market addresses, published from
 * shared/addresses.json by build_feed_data.py's write_addresses().
 */

const client = createPublicClient({
  chain: xLayerTestnet,
  transport: xLayerTransport(),
});

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

/**
 * Every listed market's live state in one Multicall3 call, so resolved and
 * yesWon always come from the same block (lib/market-live.ts). Separate
 * calls can be answered by different RPC nodes, and one a few blocks behind
 * would pair resolved = true with the pre-resolution yesWon = false.
 */
function readLiveAll(addresses: readonly Address[]): Promise<MarketLive[]> {
  return readMarketsLive(
    (contracts: LiveRead[]) => client.multicall({ contracts, allowFailure: false }),
    binaryMarketAbi,
    addresses,
  );
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
        // Only the public product; most recent market day first, and the
        // first is selected by default.
        if (!cancelled) {
          setFacts(
            result
              .filter((m) => m.metricId === PUBLIC_METRIC)
              .sort((a, b) => b.dayKey - a.dayKey),
          );
        }
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
      void readLiveAll(facts.map((m) => m.address))
        .then((states) => {
          if (cancelled) return;
          const next = Object.fromEntries(
            states.map((state, i) => [facts[i].address, state]),
          );
          setLive((previous) => keepSettled(previous, next));
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
  /**
   * True when the swap is the second leg of a Buy YES / Buy NO (it swaps
   * exactly an amount the same wallet just minted); false for a switch
   * between sides. See lib/position.ts.
   */
  buyLeg: boolean;
}

export type TradeHistory =
  | { state: 'loading' }
  | { state: 'ready'; trades: Trade[] }
  | { state: 'too-long' }
  | { state: 'error' };

const swappedEvent = parseAbiItem(
  'event Swapped(address indexed account, bool indexed yesForNo, uint256 amountIn, uint256 amountOut)',
);
const setMintedEvent = parseAbiItem(
  'event SetMinted(address indexed account, uint256 amount)',
);
const redeemedEvent = parseAbiItem(
  'event Redeemed(address indexed account, uint256 yesBurned, uint256 noBurned, uint256 payout)',
);

/** One wallet's market event, as History reads it. */
type MarketEvent = {
  account: Address;
  txHash: Hash;
  blockNumber: bigint;
} & PositionEvent;

/** Mark each swap as a buy leg or a switch, per wallet, in event order. */
function labelSwaps(
  events: readonly ({ account: Address } & PositionEvent)[],
): boolean[] {
  const byAccount = new Map<string, number[]>();
  events.forEach((event, index) => {
    const key = event.account.toLowerCase();
    byAccount.set(key, [...(byAccount.get(key) ?? []), index]);
  });
  const labels = new Map<number, boolean>();
  for (const indexes of byAccount.values()) {
    const own = indexes.map((i) => events[i]);
    const legs = swapIsBuyLeg(own);
    let swap = 0;
    own.forEach((event, j) => {
      if (event.kind === 'swap') labels.set(indexes[j], legs[swap++]);
    });
  }
  return events.flatMap((event, index) =>
    event.kind === 'swap' ? [labels.get(index) ?? false] : [],
  );
}

/**
 * Every Swapped event the market has emitted, labelled buy or switch from
 * the SetMinted events read in the same calls. Swaps revert once
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
  const events: MarketEvent[] = [];
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
        events: [swappedEvent, setMintedEvent],
        fromBlock: from,
        toBlock: to,
      }),
      client.getBlock({ blockNumber: to }),
    ]);
    for (const log of logs) {
      const base = {
        account: log.args.account as Address,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      };
      events.push(
        log.eventName === 'SetMinted'
          ? { ...base, kind: 'mint', amount: log.args.amount as bigint }
          : {
              ...base,
              kind: 'swap',
              yesForNo: log.args.yesForNo as boolean,
              amountIn: log.args.amountIn as bigint,
              amountOut: log.args.amountOut as bigint,
            },
      );
    }
    if (Number(endBlock.timestamp) >= market.resolveAfter) break;
    from = to + 1n;
  }
  const buyLegs = labelSwaps(events);
  const trades = events
    .filter((event) => event.kind === 'swap')
    .map((event, i) => ({
      txHash: event.txHash,
      blockNumber: event.blockNumber,
      account: event.account,
      yesForNo: event.yesForNo,
      amountIn: event.amountIn,
      amountOut: event.amountOut,
      buyLeg: buyLegs[i],
    }));
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

export type PositionHistory =
  | { state: 'loading' }
  | { state: 'ready'; ledger: Ledger }
  | { state: 'error'; undetermined: UndeterminedReason };

/** What has been read for one wallet on one market, extended as the chain grows. */
interface PositionScan {
  head: bigint;
  headValue: string;
  events: PositionEvent[];
}

const positionScans = new Map<string, PositionScan>();

/**
 * One wallet's own market events, oldest first, from the market's creation
 * block to the chain head. A log scan over the whole range would take one
 * request per 100 blocks (thousands for a market that has traded for days),
 * so instead the wallet's YES and NO balances are bisected to find the few
 * blocks where they changed, and only those blocks' logs are read. A block
 * whose balance changed without one of this wallet's market events is a
 * transfer. Results are kept per wallet and market and extended from the
 * last block read.
 */
async function scanPosition(
  account: Address,
  market: Pick<MarketFacts, 'address' | 'createTxHash' | 'yesToken' | 'noToken'>,
): Promise<PositionEvent[]> {
  const key = `${account}:${market.address}`.toLowerCase();
  const previous = positionScans.get(key);
  const from =
    previous?.head ??
    (await client.getTransactionReceipt({ hash: market.createTxHash }))
      .blockNumber;
  const head = await client.getBlockNumber();

  const balanceAt = (token: Address, blockNumber: bigint) =>
    client.readContract({
      address: token,
      abi: outcomeTokenAbi,
      functionName: 'balanceOf',
      args: [account],
      blockNumber,
    }) as Promise<bigint>;
  const probe = async (blockNumber: bigint) => {
    const [yes, no] = await Promise.all([
      balanceAt(market.yesToken, blockNumber),
      balanceAt(market.noToken, blockNumber),
    ]);
    return `${yes}:${no}`;
  };

  const headValue = await probe(head);
  const changes = await findChangeBlocks(
    probe,
    from,
    head,
    previous?.headValue,
  );
  const events = [...(previous?.events ?? [])];
  for (const blockNumber of changes) {
    const logs = await client.getLogs({
      address: market.address,
      // The account filter is applied below: getLogs can't filter an
      // indexed argument across several event types at once.
      events: [setMintedEvent, swappedEvent, redeemedEvent],
      fromBlock: blockNumber,
      toBlock: blockNumber,
    });
    const own = logs.filter(
      (log) =>
        (log.args.account as Address | undefined)?.toLowerCase() ===
        account.toLowerCase(),
    );
    if (own.length === 0) events.push({ kind: 'transfer' });
    for (const log of own) {
      if (log.eventName === 'SetMinted') {
        events.push({ kind: 'mint', amount: log.args.amount as bigint });
      } else if (log.eventName === 'Swapped') {
        events.push({
          kind: 'swap',
          yesForNo: log.args.yesForNo as boolean,
          amountIn: log.args.amountIn as bigint,
          amountOut: log.args.amountOut as bigint,
        });
      } else {
        events.push({
          kind: 'redeem',
          yesBurned: log.args.yesBurned as bigint,
          noBurned: log.args.noBurned as bigint,
        });
      }
    }
  }
  positionScans.set(key, { head, headValue, events });
  return events;
}

/**
 * The ledger behind the Positions tab: cost basis from this wallet's own
 * trades on the selected market. Rescans (incrementally) when the price or
 * the wallet's balances move.
 */
export function usePosition(
  account?: Address,
  market?: Market,
  balances?: Balances,
): PositionHistory {
  const [position, setPosition] = React.useState<{
    key?: string;
    value: PositionHistory;
  }>({ value: { state: 'loading' } });
  const address = market?.address;
  const createTxHash = market?.createTxHash;
  const yesToken = market?.yesToken;
  const noToken = market?.noToken;
  const price = market?.live?.priceE18.toString();
  const held = balances ? `${balances.yes}:${balances.no}` : undefined;
  const key =
    account && address && held
      ? `${account}:${address}:${price}:${held}`
      : undefined;

  React.useEffect(() => {
    if (!account || !address || !createTxHash || !yesToken || !noToken) return;
    if (held === undefined) return;
    let cancelled = false;
    const done = `${account}:${address}:${price}:${held}`;
    void scanPosition(account, { address, createTxHash, yesToken, noToken })
      .then((events) => {
        if (!cancelled) {
          setPosition({
            key: done,
            value: { state: 'ready', ledger: buildLedger(events) },
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPosition({
            key: done,
            value: { state: 'error', undetermined: 'history' },
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [account, address, createTxHash, yesToken, noToken, price, held]);

  return position.key === key ? position.value : { state: 'loading' };
}
