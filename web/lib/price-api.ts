import { formatUnits, type Abi, type Address, type Hash } from 'viem';

import type { CommittedRecord } from './feed-data.ts';
import { readingsMatch } from './feed-verification.ts';
import { dailyMwh, ladder, scenarios, yesCostFor } from './hedge.ts';
import {
  FACT_FIELDS,
  PUBLIC_METRIC,
  dayLabel,
  factsFrom,
  marketName,
  marketStatus,
  type Market,
  type MarketStatus,
} from './market-facts.ts';
import type { MarketLive } from './market-live.ts';
import { compareMarkets } from './market-order.ts';
import type { DemoDayEvidence } from './site-data.ts';

/**
 * The Texas power price API under /api/v1: what each route answers, built
 * from the committed price data and injected chain reads, so the routes
 * in app/api/v1 stay thin and everything here runs under node --test.
 * Every body is plain JSON; amounts are whole tokens and dollars, never
 * base units or E18.
 */

export const PRICE_METRIC_ID = PUBLIC_METRIC;
export const API_PRICE = '$0.01';
export const API_ASSET = 'USDT0';
export const DEFAULT_NETWORK = 'eip155:1952';

/** A route's answer: an HTTP status and the JSON body to send. */
export interface ApiResult {
  status: number;
  body: unknown;
}

export interface PaymentInfo {
  mode: 'x402' | 'free';
  price: string;
  asset: string;
  payTo: string | null;
}

export const ENDPOINTS = [
  {
    path: '/api/v1/price',
    description:
      'The Texas power price for one day in USD/MWh, with its on-chain oracle reading on X Layer and whether the two match.',
    params: { day: 'YYYY-MM-DD, optional. Defaults to the latest day in the data.' },
  },
  {
    path: '/api/v1/markets',
    description:
      'The YES/NO questions on the Texas power price: strike, day, status, and YES and NO prices from each pool.',
    params: { status: '"trading" (default) or "all".' },
  },
  {
    path: '/api/v1/hedge-quote',
    description:
      'A ladder of YES tokens across one day\'s strikes that pays a load\'s extra power cost above the lowest strike, with its indicative cost and payout scenarios.',
    params: {
      mw: 'Load in megawatts, default 10.',
      hours: 'Hours a day at that load, 1 to 24, default 24.',
      day: 'YYYY-MM-DD, optional. Defaults to the earliest day with a trading market.',
      protectTo: 'USD/MWh the ladder pays up to, default 80.',
    },
  },
] as const;

export function apiIndex(payment: PaymentInfo, network: string) {
  return {
    name: 'GRIDFLEX Texas power price API',
    description:
      'The daily Texas power price that GRIDFLEX publishes to its oracle on X Layer, the YES/NO questions that settle on it, and hedge quotes built from them. X Layer testnet; markets settle in mUSDT.',
    network,
    payment,
    endpoints: ENDPOINTS,
  };
}

/** "2026-09-08" -> 20260908, or null unless it is a real calendar date. */
export function dayKeyOf(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = new Date(Date.UTC(year, month - 1, date));
  if (utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== date) return null;
  return year * 10_000 + month * 100 + date;
}

/** 20260908 -> "2026-09-08". dayKey is a label, never a timestamp. */
export function dayOfKey(dayKey: number): string {
  const s = String(dayKey);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

// ---------------------------------------------------------------------------
// /price

/** GridOracle.getReading's fields this API uses. */
export interface OracleReading {
  value: bigint;
  sourceHash: string;
  publishedAt: bigint;
  finalized: boolean;
}

/** getReading() as viem decodes it: a named tuple, as an object or an array. */
export function oracleReadingFrom(raw: unknown): OracleReading {
  if (Array.isArray(raw)) {
    return {
      value: raw[4] as bigint,
      sourceHash: raw[5] as string,
      publishedAt: raw[6] as bigint,
      finalized: raw[7] as boolean,
    };
  }
  const reading = raw as OracleReading;
  return {
    value: reading.value,
    sourceHash: reading.sourceHash,
    publishedAt: reading.publishedAt,
    finalized: reading.finalized,
  };
}

export async function priceResult(
  records: readonly CommittedRecord[],
  evidence: DemoDayEvidence | null,
  oracleAddress: string,
  day: string | null,
  readOracle: (dayKey: number) => Promise<unknown>,
): Promise<ApiResult> {
  if (records.length === 0) {
    return { status: 503, body: { error: 'No Texas power price data is published yet.' } };
  }
  const availableFrom = records[0].marketDay;
  const availableTo = records[records.length - 1].marketDay;
  let record = records[records.length - 1];
  if (day !== null) {
    const dayKey = dayKeyOf(day);
    if (dayKey === null) {
      return { status: 400, body: { error: 'day must be a date as YYYY-MM-DD.' } };
    }
    const found = records.find((candidate) => candidate.dayKey === dayKey);
    if (!found) {
      return {
        status: 404,
        body: { error: `No Texas power price for ${day}.`, availableFrom, availableTo },
      };
    }
    record = found;
  }

  // getReading() never reverts: an unpublished day reads as zeros with
  // publishedAt = 0. If X Layer can't be reached, `published` falls back
  // to the committed ledger's transaction and nothing is claimed as checked.
  let oracle: {
    published: boolean;
    final: boolean | null;
    onchainValueCents: number | null;
    matches: boolean | null;
    checked: boolean;
  };
  try {
    const reading = oracleReadingFrom(await readOracle(record.dayKey));
    const published = reading.publishedAt > 0n;
    oracle = {
      published,
      final: published ? reading.finalized : null,
      onchainValueCents: published ? Number(reading.value) : null,
      matches: published
        ? readingsMatch({ value: record.value, sourceHash: record.sourceHash }, reading)
        : null,
      checked: true,
    };
  } catch {
    oracle = {
      published: record.txHash !== null,
      final: null,
      onchainValueCents: null,
      matches: null,
      checked: false,
    };
  }

  return {
    status: 200,
    body: {
      metricId: PRICE_METRIC_ID,
      name: 'Texas power price',
      unit: 'USD/MWh',
      day: record.marketDay,
      dayKey: record.dayKey,
      value: record.value / 100,
      valueCents: record.value,
      // Verified: the oracle on X Layer holds this exact value and source hash.
      verified: oracle.matches === true,
      sourceHash: record.sourceHash,
      // The raw source files are published for the evidence day only; every
      // other day is identified by its sourceHash.
      sourceFiles: evidence && evidence.dayKey === record.dayKey ? evidence.sourceFiles : [],
      oracle: {
        chainId: 1952,
        address: oracleAddress,
        txHash: record.txHash,
        ...oracle,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// /markets

/** A listed market with its facts, live state and pool, all from one block. */
export interface MarketSnapshot extends Market {
  live: MarketLive;
  /** Pool reserves in base units (6 decimals). */
  yesReserve: bigint;
  noReserve: bigint;
}

export interface BoardRead {
  address: Address;
  abi: Abi;
  functionName: string;
}

/** One Multicall3 aggregate: every read answered by one node at one block. */
export type BoardMulticall = (contracts: BoardRead[]) => Promise<readonly unknown[]>;

const BOARD_FIELDS = [
  ...FACT_FIELDS,
  'resolved',
  'cancelled',
  'yesWon',
  'price',
  'yesReserve',
  'noReserve',
] as const;

/**
 * Every listed Texas power price market, read in one multicall and sorted
 * as the site lists them. A market on any other metric is left out.
 */
export async function readBoard(
  multicall: BoardMulticall,
  abi: Abi,
  listed: readonly { market: Address; createTxHash: Hash }[],
): Promise<MarketSnapshot[]> {
  if (listed.length === 0) return [];
  const contracts = listed.flatMap(({ market }) =>
    BOARD_FIELDS.map((functionName) => ({ address: market, abi, functionName })),
  );
  const results = await multicall(contracts);
  if (results.length !== contracts.length) {
    throw new Error(`Expected ${contracts.length} results, got ${results.length}.`);
  }
  const board: MarketSnapshot[] = [];
  listed.forEach(({ market, createTxHash }, i) => {
    const values = results.slice(i * BOARD_FIELDS.length, (i + 1) * BOARD_FIELDS.length);
    let facts;
    try {
      facts = factsFrom(market, createTxHash, values.slice(0, FACT_FIELDS.length));
    } catch {
      return;
    }
    if (facts.metricId !== PUBLIC_METRIC) return;
    const [resolved, cancelled, yesWon, priceE18, yesReserve, noReserve] = values.slice(
      FACT_FIELDS.length,
    );
    board.push({
      ...facts,
      live: {
        resolved: resolved as boolean,
        cancelled: cancelled as boolean,
        yesWon: yesWon as boolean,
        priceE18: priceE18 as bigint,
      },
      yesReserve: yesReserve as bigint,
      noReserve: noReserve as bigint,
    });
  });
  return board.sort(compareMarkets);
}

function wholeTokens(units: bigint): number {
  return Number(formatUnits(units, 6));
}

export function marketRow(market: MarketSnapshot, nowMs: number) {
  const status = marketStatus(market, nowMs) as MarketStatus;
  const yesPrice = round(Number(formatUnits(market.live.priceE18, 18)), 4);
  return {
    address: market.address,
    question: marketName(market),
    day: dayOfKey(market.dayKey),
    dayKey: market.dayKey,
    strike: market.threshold / 100,
    status,
    yesPrice,
    noPrice: round(1 - yesPrice, 4),
    yesReserve: wholeTokens(market.yesReserve),
    noReserve: wholeTokens(market.noReserve),
    tradingClosesAt: new Date(market.resolveAfter * 1000).toISOString(),
    yesWon: status === 'resolved' ? market.live.yesWon : null,
    yesToken: market.yesToken,
    noToken: market.noToken,
  };
}

export type MarketRow = ReturnType<typeof marketRow>;

const CHAIN_DOWN: ApiResult = {
  status: 503,
  body: { error: 'Could not read markets from X Layer.' },
};

/** /markets: checks the query first, so a bad one costs no chain read. */
export async function marketsResult(
  status: string | null,
  nowMs: number,
  loadBoard: () => Promise<readonly MarketSnapshot[]>,
): Promise<ApiResult> {
  const filter = status ?? 'trading';
  if (filter !== 'trading' && filter !== 'all') {
    return { status: 400, body: { error: 'status must be "trading" or "all".' } };
  }
  let board: readonly MarketSnapshot[];
  try {
    board = await loadBoard();
  } catch {
    return CHAIN_DOWN;
  }
  const rows = board.map((market) => marketRow(market, nowMs));
  return {
    status: 200,
    body: { markets: filter === 'all' ? rows : rows.filter((row) => row.status === 'trading') },
  };
}

// ---------------------------------------------------------------------------
// /hedge-quote

export interface HedgeParams {
  mw: number;
  hours: number;
  protectTo: number;
  day: string | null;
}

const HEDGE_DEFAULTS = { mw: 10, hours: 24, protectTo: 80 };

/** The query's hedge parameters, or a 400 naming the first bad one. */
export function parseHedgeParams(query: URLSearchParams): HedgeParams | ApiResult {
  const number = (name: 'mw' | 'hours' | 'protectTo') => {
    const raw = query.get(name);
    return raw === null || raw.trim() === '' ? HEDGE_DEFAULTS[name] : Number(raw);
  };
  const mw = number('mw');
  const hours = number('hours');
  const protectTo = number('protectTo');
  const day = query.get('day');
  const bad = (error: string): ApiResult => ({ status: 400, body: { error } });
  if (!Number.isFinite(mw) || mw <= 0 || mw > 10_000) {
    return bad('mw must be a number of megawatts above 0 and at most 10,000.');
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    return bad('hours must be above 0 and at most 24.');
  }
  if (!Number.isFinite(protectTo) || protectTo <= 0 || protectTo > 10_000) {
    return bad('protectTo must be a price in USD/MWh above 0 and at most 10,000.');
  }
  if (day !== null && dayKeyOf(day) === null) {
    return bad('day must be a date as YYYY-MM-DD.');
  }
  return { mw, hours, protectTo, day };
}

/** /hedge-quote: checks the query first, so a bad one costs no chain read. */
export async function hedgeQuoteResult(
  query: URLSearchParams,
  nowMs: number,
  loadBoard: () => Promise<readonly MarketSnapshot[]>,
): Promise<ApiResult> {
  const params = parseHedgeParams(query);
  if ('status' in params) return params;
  let board: readonly MarketSnapshot[];
  try {
    board = await loadBoard();
  } catch {
    return CHAIN_DOWN;
  }
  return hedgeQuoteFor(board, params, nowMs);
}

export function hedgeQuoteFor(
  board: readonly MarketSnapshot[],
  params: HedgeParams,
  nowMs: number,
): ApiResult {
  const trading = board.filter((market) => marketStatus(market, nowMs) === 'trading');
  const tradingDays = [...new Set(trading.map((market) => dayOfKey(market.dayKey)))].sort();
  const day = params.day ?? tradingDays[0] ?? null;
  const onDay = trading.filter((market) => dayOfKey(market.dayKey) === day);
  if (day === null || onDay.length === 0) {
    return {
      status: 404,
      body: {
        error: day ? `No market is trading for ${day}.` : 'No market is trading.',
        tradingDays,
      },
    };
  }

  // One market per strike: the first as the site lists them.
  const byStrike = new Map<number, MarketSnapshot>();
  for (const market of onDay) {
    const strike = market.threshold / 100;
    if (!byStrike.has(strike)) byStrike.set(strike, market);
  }
  const mwh = dailyMwh(params.mw, params.hours);
  const ladderRungs = ladder(mwh, [...byStrike.keys()], params.protectTo);
  if (ladderRungs.length === 0) {
    const lowest = Math.min(...byStrike.keys());
    return {
      status: 400,
      body: { error: `protectTo must be above the lowest strike for ${day}, $${lowest}/MWh.` },
    };
  }

  const rungs = ladderRungs.map(({ strike, tokens }) => {
    const market = byStrike.get(strike) as MarketSnapshot;
    return {
      market: market.address,
      strike,
      tokens: round(tokens, 6),
      yesPrice: round(Number(formatUnits(market.live.priceE18, 18)), 4),
      cost: round(
        yesCostFor(tokens, wholeTokens(market.yesReserve), wholeTokens(market.noReserve)),
        6,
      ),
    };
  });
  const totalCost = round(
    rungs.reduce((sum, rung) => sum + rung.cost, 0),
    6,
  );
  const prices = [
    ...new Set([...ladderRungs.map((rung) => rung.strike), params.protectTo, 2 * params.protectTo]),
  ].sort((a, b) => a - b);
  const table = scenarios(mwh, ladderRungs, prices).map((row) => ({
    price: row.price,
    extraCost: round(row.extraCost, 2),
    payout: round(row.payout, 6),
    covered: row.covered === null ? null : round(row.covered, 4),
  }));
  const lowest = ladderRungs[0].strike;
  const cap = round(
    ladderRungs.reduce((sum, rung) => sum + rung.tokens, 0),
    6,
  );

  return {
    status: 200,
    body: {
      day,
      mw: params.mw,
      hours: params.hours,
      mwh,
      protectTo: params.protectTo,
      rungs,
      totalCost,
      scenarios: table,
      notes: [
        `Each YES pays 1 mUSDT if the Texas power price for ${dayLabel(onDay[0].dayKey, true)} settles above its strike. The ladder pays the extra cost of ${mwh.toLocaleString('en-US')} MWh above $${lowest}/MWh up to $${params.protectTo}/MWh; above that it stays at ${cap.toLocaleString('en-US')} mUSDT.`,
        'Indicative: costs are worked out from each pool\'s reserves now, including the price impact of the buy. A buy is sent with its own on-chain quote and a 0.50% slippage limit.',
        'Markets settle on the verified daily Texas power price published to the oracle on X Layer testnet, in mUSDT.',
      ],
    },
  };
}
