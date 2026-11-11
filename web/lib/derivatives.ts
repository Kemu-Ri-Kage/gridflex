/**
 * Chain access for the futures and options screens: the contracts' functions,
 * their addresses (from public/data/addresses.json once deployed) and the
 * reads each screen makes. Writes go through the user's wallet
 * (components/use-contract-writer.ts).
 */

import {
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
} from 'viem';

import addressesJson from '@/public/data/addresses.json';

import { xLayerTestnet, xLayerTransport } from './contracts.ts';
import type { OpenPosition } from './perp-view.ts';
import { texasDayKey } from './quote-bot.ts';

export const FEED_ID = keccak256(toBytes('ERCOT_HBNORTH_RT_5MIN'));

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);

export const feedAbi = parseAbi([
  'function latestRoundId(bytes32) view returns (uint64)',
  'function indexAt(bytes32,uint64) view returns (int64)',
  'function getRound(bytes32,uint64) view returns ((int64 priceCents,uint64 intervalEnd,uint64 publishedAt,bytes32 sourceHash))',
  'function paused() view returns (bool)',
]);

export const perpAbi = parseAbi([
  'function feeBps() view returns (uint256)',
  'function floorCents() view returns (int64)',
  'function capCents() view returns (int64)',
  'function paused() view returns (bool)',
  'function poolCash() view returns (uint256)',
  'function totalReserved() view returns (uint256)',
  'function longSize() view returns (uint256)',
  'function shortSize() view returns (uint256)',
  'function fundingRate() view returns (int256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function nextOrderId() view returns (uint256)',
  'function nextPositionId() view returns (uint256)',
  'function fundingOwed(uint256) view returns (uint256)',
  'function getPosition(uint256) view returns ((address account,bool open,bool isLong,int64 entryPriceCents,uint256 size,uint256 collateral,uint256 reserve,uint256 fundingEntry,uint256 closeOrderId))',
  'function getOrder(uint256) view returns ((address account,uint64 createdAt,bool pending,bool isOpen,bool isLong,int64 acceptablePriceCents,uint256 size,uint256 positionId,uint256 escrow,uint256 reserveHeld))',
  'function requestOpen(bool isLong,uint256 size,int64 acceptablePriceCents) returns (uint256)',
  'function requestClose(uint256 positionId) returns (uint256)',
  'function cancelOrder(uint256 orderId)',
]);

export const optionsAbi = parseAbi([
  'function floorCents() view returns (int64)',
  'function capCents() view returns (int64)',
  'function strikeStepCents() view returns (int64)',
  'function paused() view returns (bool)',
  'function poolCash() view returns (uint256)',
  'function totalReserved() view returns (uint256)',
  'function expiries(uint32) view returns (bool exists,uint64 tradingCloseUtc,uint64 quoteVersion)',
  'function getQuote(uint32,uint64,int64) view returns ((uint64 callAsk,uint64 callBid,uint64 putAsk,uint64 putBid))',
  'function seriesId(uint32,int64,bool) pure returns (bytes32)',
  'function balanceOf(bytes32,address) view returns (uint256)',
  'function requestBuy(uint32 dayKey,int64 strikeCents,bool isCall,uint256 size,uint64 maxPremiumCents) returns (uint256)',
  'function requestSell(uint32 dayKey,int64 strikeCents,bool isCall,uint256 size,uint64 minPremiumCents) returns (uint256)',
  'function claim(uint32 dayKey,int64 strikeCents,bool isCall) returns (uint256)',
]);

type Addresses = Record<string, unknown>;
const addresses = addressesJson as Addresses;

function addressOf(name: string): Address | null {
  const value = addresses[name];
  return typeof value === 'string' && isAddress(value)
    ? getAddress(value)
    : null;
}

/** The deployed contracts, or null for each one not deployed yet. */
export const deployed = {
  feed: addressOf('LivePriceFeed'),
  perp: addressOf('TexasPowerPerp'),
  options: addressOf('TexasPowerOptions'),
  collateral: addressOf('MockUSDT'),
};

export const chainClient = createPublicClient({
  chain: xLayerTestnet,
  transport: xLayerTransport(),
});

export interface PerpMarket {
  indexCents: number | null;
  band: { floorCents: number; capCents: number };
  feeBps: number;
  paused: boolean;
  poolCash: bigint;
  freePool: bigint;
  longSize: bigint;
  shortSize: bigint;
  /** Cents per MWh per hour (positive: longs pay). */
  fundingCentsPerMwhHour: number;
}

/** The market-wide figures for the futures screen. */
export async function readPerpMarket(
  perp: Address,
  feed: Address,
): Promise<PerpMarket> {
  const call = <T>(functionName: string) =>
    chainClient.readContract({
      address: perp,
      abi: perpAbi,
      functionName: functionName as never,
    }) as Promise<T>;
  const [
    feeBps,
    floorCents,
    capCents,
    paused,
    poolCash,
    totalReserved,
    longSize,
    shortSize,
    fundingRate,
  ] = await Promise.all([
    call<bigint>('feeBps'),
    call<bigint>('floorCents'),
    call<bigint>('capCents'),
    call<boolean>('paused'),
    call<bigint>('poolCash'),
    call<bigint>('totalReserved'),
    call<bigint>('longSize'),
    call<bigint>('shortSize'),
    call<bigint>('fundingRate'),
  ]);
  let indexCents: number | null = null;
  try {
    const latest = await chainClient.readContract({
      address: feed,
      abi: feedAbi,
      functionName: 'latestRoundId',
      args: [FEED_ID],
    });
    if (latest > 0n) {
      indexCents = Number(
        await chainClient.readContract({
          address: feed,
          abi: feedAbi,
          functionName: 'indexAt',
          args: [FEED_ID, latest],
        }),
      );
    }
  } catch {
    indexCents = null; // across a gap there is no index: the screen says so
  }
  return {
    indexCents,
    band: { floorCents: Number(floorCents), capCents: Number(capCents) },
    feeBps: Number(feeBps),
    paused,
    poolCash,
    freePool: poolCash - totalReserved,
    longSize,
    shortSize,
    fundingCentsPerMwhHour: Number(fundingRate) / 1e18,
  };
}

export interface MyPosition extends OpenPosition {
  id: bigint;
  closePending: boolean;
  fundingOwed: bigint;
}

export interface MyOrder {
  id: bigint;
  isOpen: boolean;
  isLong: boolean;
  size: bigint;
  limitCents: number;
  createdAt: number;
  positionId: bigint;
}

/** How many recent positions and orders the screen looks through for the user's own. */
const LOOKBACK = 300n;

/** The user's open positions and pending orders, among the most recent ones. */
export async function readMyPerp(
  perp: Address,
  account: Address,
): Promise<{ positions: MyPosition[]; orders: MyOrder[] }> {
  const [nextPosition, nextOrder] = await Promise.all([
    chainClient.readContract({
      address: perp,
      abi: perpAbi,
      functionName: 'nextPositionId',
    }),
    chainClient.readContract({
      address: perp,
      abi: perpAbi,
      functionName: 'nextOrderId',
    }),
  ]);
  const ids = (next: bigint) => {
    const first = next > LOOKBACK ? next - LOOKBACK : 1n;
    return Array.from(
      { length: Number(next - first) },
      (_, i) => first + BigInt(i),
    );
  };
  const positionIds = ids(nextPosition);
  const orderIds = ids(nextOrder);
  const [positions, orders] = await Promise.all([
    chainClient.multicall({
      allowFailure: false,
      contracts: positionIds.map((id) => ({
        address: perp,
        abi: perpAbi,
        functionName: 'getPosition' as const,
        args: [id] as const,
      })),
    }),
    chainClient.multicall({
      allowFailure: false,
      contracts: orderIds.map((id) => ({
        address: perp,
        abi: perpAbi,
        functionName: 'getOrder' as const,
        args: [id] as const,
      })),
    }),
  ]);
  const mine = (a: Address) => a.toLowerCase() === account.toLowerCase();
  const openIds = positionIds.filter(
    (_, i) => positions[i].open && mine(positions[i].account),
  );
  const owed = openIds.length
    ? await chainClient.multicall({
        allowFailure: false,
        contracts: openIds.map((id) => ({
          address: perp,
          abi: perpAbi,
          functionName: 'fundingOwed' as const,
          args: [id] as const,
        })),
      })
    : [];
  return {
    positions: openIds.map((id, k) => {
      const p = positions[positionIds.indexOf(id)];
      return {
        id,
        isLong: p.isLong,
        entryPriceCents: Number(p.entryPriceCents),
        size: p.size,
        collateral: p.collateral,
        reserve: p.reserve,
        closePending: p.closeOrderId !== 0n,
        fundingOwed: owed[k],
      };
    }),
    orders: orderIds.flatMap((id, i) => {
      const o = orders[i];
      return o.pending && mine(o.account)
        ? [
            {
              id,
              isOpen: o.isOpen,
              isLong: o.isLong,
              size: o.size,
              limitCents: Number(o.acceptablePriceCents),
              createdAt: Number(o.createdAt),
              positionId: o.positionId,
            },
          ]
        : [];
    }),
  };
}

// ---------------------------------------------------------------- options

export interface OptionRow {
  strikeCents: number;
  callAsk: number;
  callBid: number;
  putAsk: number;
  putBid: number;
  myCall: bigint;
  myPut: bigint;
}

export interface OptionExpiry {
  dayKey: number;
  closeUtc: number;
  version: bigint;
  rows: OptionRow[];
}

export interface Holding {
  dayKey: number;
  strikeCents: number;
  isCall: boolean;
  size: bigint;
}

export interface OptionsBoard {
  band: { floorCents: number; capCents: number };
  paused: boolean;
  freePool: bigint;
  expiries: OptionExpiry[];
  /** Options held on days that stopped trading: claim them once the day's price is final. */
  toClaim: Holding[];
}

/** The series id the contract uses: keccak256(abi.encode(dayKey, strike, isCall)). */
export function optionSeriesId(
  dayKey: number,
  strikeCents: number,
  isCall: boolean,
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint32' }, { type: 'int64' }, { type: 'bool' }],
      [dayKey, BigInt(strikeCents), isCall],
    ),
  );
}

function shiftDay(dayKey: number, days: number): number {
  const d = new Date(
    Date.UTC(
      Math.floor(dayKey / 10_000),
      Math.floor((dayKey % 10_000) / 100) - 1,
      dayKey % 100,
    ) +
      days * 86_400_000,
  );
  return (
    d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
  );
}

/** The listed days with their latest quotes, and the user's options, from one board of reads. */
export async function readOptionsBoard(
  options: Address,
  account: Address | undefined,
  nowMs: number,
  grid: number[],
): Promise<OptionsBoard> {
  const read = <T>(functionName: string) =>
    chainClient.readContract({
      address: options,
      abi: optionsAbi,
      functionName: functionName as never,
    }) as Promise<T>;
  const [floorCents, capCents, paused, poolCash, totalReserved] =
    await Promise.all([
      read<bigint>('floorCents'),
      read<bigint>('capCents'),
      read<boolean>('paused'),
      read<bigint>('poolCash'),
      read<bigint>('totalReserved'),
    ]);
  const today = texasDayKey(nowMs);
  const days = Array.from({ length: 18 }, (_, i) => shiftDay(today, i - 10)); // 10 days back, 7 ahead
  const listed = await chainClient.multicall({
    allowFailure: false,
    contracts: days.map((d) => ({
      address: options,
      abi: optionsAbi,
      functionName: 'expiries' as const,
      args: [d] as const,
    })),
  });
  const now = nowMs / 1000;
  const open = days.flatMap((d, i) => {
    const [exists, close, version] = listed[i];
    return exists && Number(close) > now && version > 0n
      ? [{ dayKey: d, closeUtc: Number(close), version }]
      : [];
  });
  const closed = days.filter(
    (_, i) => listed[i][0] && Number(listed[i][1]) <= now,
  );

  const quotes = open.length
    ? await chainClient.multicall({
        allowFailure: false,
        contracts: open.flatMap((e) =>
          grid.map((s) => ({
            address: options,
            abi: optionsAbi,
            functionName: 'getQuote' as const,
            args: [e.dayKey, e.version, BigInt(s)] as const,
          })),
        ),
      })
    : [];
  const holdingKeys = account
    ? [...open.map((e) => e.dayKey), ...closed].flatMap((d) =>
        grid.flatMap((s) => [true, false].map((isCall) => ({ d, s, isCall }))),
      )
    : [];
  const held = holdingKeys.length
    ? await chainClient.multicall({
        allowFailure: false,
        contracts: holdingKeys.map((k) => ({
          address: options,
          abi: optionsAbi,
          functionName: 'balanceOf' as const,
          args: [optionSeriesId(k.d, k.s, k.isCall), account!] as const,
        })),
      })
    : [];
  const heldOf = (d: number, s: number, isCall: boolean) => {
    const i = holdingKeys.findIndex(
      (k) => k.d === d && k.s === s && k.isCall === isCall,
    );
    return i < 0 ? 0n : held[i];
  };

  return {
    band: { floorCents: Number(floorCents), capCents: Number(capCents) },
    paused,
    freePool: poolCash - totalReserved,
    expiries: open.map((e, i) => ({
      ...e,
      rows: grid.flatMap((s, j) => {
        const q = quotes[i * grid.length + j];
        if (q.callAsk === 0n && q.putAsk === 0n) return [];
        return [
          {
            strikeCents: s,
            callAsk: Number(q.callAsk),
            callBid: Number(q.callBid),
            putAsk: Number(q.putAsk),
            putBid: Number(q.putBid),
            myCall: heldOf(e.dayKey, s, true),
            myPut: heldOf(e.dayKey, s, false),
          },
        ];
      }),
    })),
    toClaim: closed.flatMap((d) =>
      grid.flatMap((s) =>
        [true, false].flatMap((isCall) => {
          const size = heldOf(d, s, isCall);
          return size > 0n ? [{ dayKey: d, strikeCents: s, isCall, size }] : [];
        }),
      ),
    ),
  };
}
