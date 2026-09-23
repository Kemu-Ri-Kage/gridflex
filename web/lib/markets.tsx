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

const swappedEvent = parseAbiItem(
  'event Swapped(address indexed account, bool indexed yesForNo, uint256 amountIn, uint256 amountOut)',
);
const setMintedEvent = parseAbiItem(
  'event SetMinted(address indexed account, uint256 amount)',
);
const redeemedEvent = parseAbiItem(
  'event Redeemed(address indexed account, uint256 yesBurned, uint256 noBurned, uint256 payout)',
);
const approvalEvent = parseAbiItem(
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
);

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

export type ApprovedToken = 'mUSDT' | 'YES' | 'NO';

/** One of a wallet's own transactions on one market, as History lists it. */
export type WalletAction =
  | { kind: 'approve'; token: ApprovedToken; amount: bigint }
  | { kind: 'mint'; amount: bigint }
  | {
      kind: 'swap';
      yesForNo: boolean;
      amountIn: bigint;
      amountOut: bigint;
      /**
       * True when the swap is the second leg of a Buy YES / Buy NO (it
       * swaps exactly an amount the same wallet just minted); false for a
       * switch between sides. See lib/position.ts.
       */
      buyLeg: boolean;
    }
  | { kind: 'redeem'; yesBurned: bigint; noBurned: bigint; payout: bigint };

export interface WalletTrade {
  txHash: Hash;
  blockNumber: bigint;
  /** Block time, unix seconds. */
  timestamp: number;
  action: WalletAction;
}

export type TradeHistory =
  | { state: 'loading' }
  | {
      state: 'ready';
      /** Newest first. */
      trades: WalletTrade[];
      /** False when the search stopped at its budget: trades may be missing. */
      complete: boolean;
      /** The market's creation block - the search never goes further back. */
      fromBlock: bigint;
      toBlock: bigint;
    }
  | { state: 'error' };

type ActionEvent =
  | Exclude<PositionEvent, { kind: 'transfer' | 'redeem' }>
  | { kind: 'redeem'; yesBurned: bigint; noBurned: bigint; payout: bigint }
  | { kind: 'approve'; token: ApprovedToken; amount: bigint };

type ScannedEvent =
  | { blockNumber: bigint; txHash: Hash; timestamp: number; event: ActionEvent }
  /** The balance changed in a block with none of this wallet's market events. */
  | { blockNumber: bigint; event: { kind: 'transfer' } };

/** What has been read for one wallet on one market, extended as the chain grows. */
interface WalletScan {
  floor: bigint;
  head: bigint;
  headValue: string;
  complete: boolean;
  events: ScannedEvent[];
}

type ScanMarket = Pick<
  MarketFacts,
  'address' | 'createTxHash' | 'yesToken' | 'noToken'
>;

/**
 * Parts each changed block range is split into per round trip: the search
 * takes about log16(span) round trips - four for a day-old market - at up
 * to 15 reads per changed range per round trip.
 */
const SCAN_FANOUT = 16;
/**
 * Probe reads one scan may spend. A wallet with more activity than this
 * finds gets the actions found so far, marked partial.
 */
const MAX_SCAN_PROBES = 1_000;
/** Probe reads in flight at once, so a busy wallet doesn't flood the RPC. */
const MAX_PROBES_IN_FLIGHT = 32;

const walletScans = new Map<string, WalletScan>();
const walletScanQueue = new Map<string, Promise<unknown>>();

/**
 * One wallet's own actions on one market, oldest first, from the market's
 * creation block to the chain head. A log scan over the whole range would
 * take one request per 100 blocks (the RPC's getLogs limit - thousands for
 * a market that has traded for days), so instead the wallet's YES and NO
 * balances and its three allowances to the market (mUSDT, YES, NO) are
 * read in one Multicall3 call per probe and searched for the few blocks
 * where they changed; only those blocks' logs are read. Every trade moves
 * a balance and every approval sets an allowance, so none is skipped. A
 * block whose balances changed without one of this wallet's market events
 * is a transfer. Results are kept per wallet and market and extended from
 * the last block read; Positions and History share them, one scan at a
 * time per wallet and market.
 */
function scanWallet(
  account: Address,
  collateral: Address,
  market: ScanMarket,
): Promise<WalletScan> {
  const key = `${account}:${market.address}`.toLowerCase();
  const previous = walletScanQueue.get(key) ?? Promise.resolve();
  const scan = previous
    .catch(() => undefined)
    .then(() => extendWalletScan(key, account, collateral, market));
  walletScanQueue.set(key, scan);
  void scan
    .catch(() => undefined)
    .then(() => {
      if (walletScanQueue.get(key) === scan) walletScanQueue.delete(key);
    });
  return scan;
}

async function extendWalletScan(
  key: string,
  account: Address,
  collateral: Address,
  market: ScanMarket,
): Promise<WalletScan> {
  const previous = walletScans.get(key);
  const floor =
    previous?.floor ??
    (await client.getTransactionReceipt({ hash: market.createTxHash }))
      .blockNumber;
  const from = previous?.head ?? floor;
  const head = await client.getBlockNumber();
  if (previous && head <= previous.head) return previous;

  const tokens: Record<ApprovedToken, Address> = {
    mUSDT: collateral,
    YES: market.yesToken,
    NO: market.noToken,
  };
  let inFlight = 0;
  const waiting: (() => void)[] = [];
  const probe = async (blockNumber: bigint) => {
    if (inFlight >= MAX_PROBES_IN_FLIGHT) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    inFlight += 1;
    try {
      const [yes, no, ...allowances] = await client.multicall({
        blockNumber,
        allowFailure: false,
        contracts: [
          ...[market.yesToken, market.noToken].map((address) => ({
            address,
            abi: outcomeTokenAbi,
            functionName: 'balanceOf',
            args: [account],
          })),
          ...Object.values(tokens).map((address) => ({
            address,
            abi: address === collateral ? mockUsdtAbi : outcomeTokenAbi,
            functionName: 'allowance',
            args: [account, market.address],
          })),
        ],
      });
      // Balances before the slash: a change there is a trade or transfer.
      return `${String(yes)}:${String(no)}/${allowances.map(String).join(':')}`;
    } finally {
      inFlight -= 1;
      waiting.shift()?.();
    }
  };

  const search = await findChangeBlocks(probe, from, head, {
    fromValue: previous?.headValue,
    fanout: SCAN_FANOUT,
    maxProbes: MAX_SCAN_PROBES,
  });
  let before = previous?.headValue ?? (await probe(from));
  const balancesMoved = search.changes.map((change) => {
    const moved = change.value.split('/')[0] !== before.split('/')[0];
    before = change.value;
    return moved;
  });

  const blocks = await Promise.all(
    search.changes.map(async ({ block }, i) => {
      const logs = await client.getLogs({
        address: [market.address, ...Object.values(tokens)],
        // The account filter is applied below: getLogs can't filter an
        // indexed argument across several event types at once.
        events: [setMintedEvent, swappedEvent, redeemedEvent, approvalEvent],
        fromBlock: block,
        toBlock: block,
      });
      const own = (address: unknown) =>
        typeof address === 'string' &&
        address.toLowerCase() === account.toLowerCase();
      const found: { txHash: Hash; event: ActionEvent }[] = [];
      for (const log of logs) {
        const onMarket =
          log.address.toLowerCase() === market.address.toLowerCase();
        let event: ActionEvent | undefined;
        if (log.eventName === 'Approval') {
          const token = (Object.keys(tokens) as ApprovedToken[]).find(
            (name) => tokens[name].toLowerCase() === log.address.toLowerCase(),
          );
          if (
            token &&
            own(log.args.owner) &&
            log.args.spender?.toLowerCase() === market.address.toLowerCase()
          ) {
            event = { kind: 'approve', token, amount: log.args.value as bigint };
          }
        } else if (!onMarket || !own(log.args.account)) {
          continue;
        } else if (log.eventName === 'SetMinted') {
          event = { kind: 'mint', amount: log.args.amount as bigint };
        } else if (log.eventName === 'Swapped') {
          event = {
            kind: 'swap',
            yesForNo: log.args.yesForNo as boolean,
            amountIn: log.args.amountIn as bigint,
            amountOut: log.args.amountOut as bigint,
          };
        } else {
          event = {
            kind: 'redeem',
            yesBurned: log.args.yesBurned as bigint,
            noBurned: log.args.noBurned as bigint,
            payout: log.args.payout as bigint,
          };
        }
        if (event) found.push({ txHash: log.transactionHash, event });
      }
      const scanned: ScannedEvent[] = [];
      if (found.length > 0) {
        const { timestamp } = await client.getBlock({ blockNumber: block });
        for (const { txHash, event } of found) {
          scanned.push({
            blockNumber: block,
            txHash,
            timestamp: Number(timestamp),
            event,
          });
        }
      }
      const traded = found.some(({ event }) => event.kind !== 'approve');
      if (balancesMoved[i] && !traded) {
        scanned.push({ blockNumber: block, event: { kind: 'transfer' } });
      }
      return scanned;
    }),
  );

  const scan: WalletScan = {
    floor,
    head,
    headValue: search.toValue,
    complete: (previous?.complete ?? true) && search.complete,
    events: [...(previous?.events ?? []), ...blocks.flat()],
  };
  walletScans.set(key, scan);
  return scan;
}
/** A scan's market events in the form lib/position.ts replays. */
function positionEvents(scan: WalletScan): PositionEvent[] {
  return scan.events.flatMap(({ event }) =>
    event.kind === 'approve' ? [] : [event],
  );
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
  const addresses = useAddresses();
  const [position, setPosition] = React.useState<{
    key?: string;
    value: PositionHistory;
  }>({ value: { state: 'loading' } });
  const collateral = addresses?.MockUSDT;
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
    if (!account || !collateral || !address || !createTxHash) return;
    if (!yesToken || !noToken || held === undefined) return;
    let cancelled = false;
    const done = `${account}:${address}:${price}:${held}`;
    void scanWallet(account, getAddress(collateral), {
      address,
      createTxHash,
      yesToken,
      noToken,
    })
      .then((scan) => {
        if (!cancelled) {
          setPosition({
            key: done,
            // A partial scan may be missing a buy, so it can't state a cost.
            value: scan.complete
              ? { state: 'ready', ledger: buildLedger(positionEvents(scan)) }
              : { state: 'error', undetermined: 'history' },
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
  }, [account, collateral, address, createTxHash, yesToken, noToken, price, held]);

  return position.key === key ? position.value : { state: 'loading' };
}

/** A scan as History lists it: this wallet's actions, newest first. */
function historyOf(scan: WalletScan): TradeHistory {
  const buyLegs = swapIsBuyLeg(positionEvents(scan));
  let swap = 0;
  const trades: WalletTrade[] = [];
  for (const entry of scan.events) {
    if (!('txHash' in entry)) continue;
    const { event } = entry;
    trades.push({
      txHash: entry.txHash,
      blockNumber: entry.blockNumber,
      timestamp: entry.timestamp,
      action:
        event.kind === 'swap' ? { ...event, buyLeg: buyLegs[swap++] } : event,
    });
  }
  return {
    state: 'ready',
    trades: trades.reverse(),
    complete: scan.complete,
    fromBlock: scan.floor,
    toBlock: scan.head,
  };
}

/**
 * The History tab: the connected wallet's own actions on the selected
 * market - approvals, mints, swaps and redemptions - from the market's
 * creation block to the chain head (see scanWallet). Extended on every
 * market poll, keeping the last list on screen while it does.
 */
export function useTradeHistory(
  account?: Address,
  market?: Market,
): TradeHistory {
  const addresses = useAddresses();
  const { now } = useMarkets();
  const [history, setHistory] = React.useState<{
    id?: string;
    value: TradeHistory;
  }>({ value: { state: 'loading' } });
  const collateral = addresses?.MockUSDT;
  const address = market?.address;
  const createTxHash = market?.createTxHash;
  const yesToken = market?.yesToken;
  const noToken = market?.noToken;
  const id = account && address ? `${account}:${address}` : undefined;

  React.useEffect(() => {
    if (!account || !collateral || !address || !createTxHash) return;
    if (!yesToken || !noToken) return;
    let cancelled = false;
    const done = `${account}:${address}`;
    void scanWallet(account, getAddress(collateral), {
      address,
      createTxHash,
      yesToken,
      noToken,
    })
      .then((scan) => {
        if (!cancelled) setHistory({ id: done, value: historyOf(scan) });
      })
      .catch(() => {
        // A failed refresh keeps the list already shown.
        if (!cancelled) {
          setHistory((current) =>
            current.id === done ? current : { id: done, value: { state: 'error' } },
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [account, collateral, address, createTxHash, yesToken, noToken, now]);

  return history.id === id ? history.value : { state: 'loading' };
}
