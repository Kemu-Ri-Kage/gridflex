import assert from 'node:assert/strict';
import { test } from 'node:test';

import { keccak256, parseUnits, toBytes, type Abi, type Address, type Hash } from 'viem';

import type { CommittedRecord } from './feed-data.ts';
import { yesOutFor } from './hedge.ts';
import {
  dayKeyOf,
  dayOfKey,
  hedgeQuoteResult,
  marketsResult,
  parseHedgeParams,
  priceResult,
  readBoard,
  type MarketSnapshot,
} from './price-api.ts';

const NOW = Date.UTC(2026, 8, 24, 12);
const LATER = Date.UTC(2026, 8, 26) / 1000;
const EARLIER = Date.UTC(2026, 8, 20) / 1000;
const E18 = 10n ** 18n;

function market(
  n: number,
  dayKey: number,
  strikeCents: number,
  overrides: Partial<MarketSnapshot> = {},
): MarketSnapshot {
  return {
    address: `0x${String(n).padStart(40, '0')}` as Address,
    createTxHash: `0x${'ab'.repeat(32)}` as Hash,
    metricId: 'ERCOT_HBNORTH_DA_AVG',
    metricIdBytes: keccak256(toBytes('ERCOT_HBNORTH_DA_AVG')),
    dayKey,
    threshold: strikeCents,
    resolveAfter: LATER,
    yesToken: `0x${'1'.repeat(40)}` as Address,
    noToken: `0x${'2'.repeat(40)}` as Address,
    live: { resolved: false, cancelled: false, yesWon: false, priceE18: E18 / 2n },
    yesReserve: parseUnits('1000', 6),
    noReserve: parseUnits('1000', 6),
    ...overrides,
  };
}

const records: CommittedRecord[] = [
  { dayKey: 20260907, marketDay: '2026-09-07', value: 3810, sourceHash: 'aa', txHash: null },
  { dayKey: 20260908, marketDay: '2026-09-08', value: 3957, sourceHash: 'bb', txHash: '0xfeed' },
];

void test('a day is a real calendar date as YYYY-MM-DD, keyed as YYYYMMDD', () => {
  assert.equal(dayKeyOf('2026-09-08'), 20260908);
  assert.equal(dayKeyOf('2026-02-30'), null);
  assert.equal(dayKeyOf('8 Sep 2026'), null);
  assert.equal(dayOfKey(20260908), '2026-09-08');
});

void test('the price defaults to the latest day and reports a matching oracle reading as verified', async () => {
  const result = await priceResult(records, null, '0xoracle', null, async () => ({
    value: 3957n,
    sourceHash: '0xBB',
    publishedAt: 1n,
    finalized: true,
  }));
  assert.equal(result.status, 200);
  const body = result.body as Record<string, unknown>;
  assert.equal(body.day, '2026-09-08');
  assert.equal(body.value, 39.57);
  assert.equal(body.verified, true);
  assert.deepEqual(body.oracle, {
    chainId: 1952,
    address: '0xoracle',
    txHash: '0xfeed',
    published: true,
    final: true,
    onchainValueCents: 3957,
    matches: true,
    checked: true,
  });
});

void test('an unpublished day is not verified, and an unreachable chain claims no check', async () => {
  const zeros = [0n, 0, 0n, 0n, 0n, `0x${'0'.repeat(64)}`, 0n, false];
  const unpublished = await priceResult(records, null, '0xo', '2026-09-07', async () => zeros);
  const oracle = (unpublished.body as { oracle: Record<string, unknown> }).oracle;
  assert.equal(oracle.published, false);
  assert.equal(oracle.matches, null);
  assert.equal((unpublished.body as { verified: boolean }).verified, false);

  const down = await priceResult(records, null, '0xo', '2026-09-08', async () => {
    throw new Error('timeout');
  });
  const downOracle = (down.body as { oracle: Record<string, unknown> }).oracle;
  assert.equal(downOracle.checked, false);
  assert.equal(downOracle.published, true); // from the committed ledger
  assert.equal(downOracle.matches, null);
});

void test('a bad day is a 400 and a missing day a 404 naming the range', async () => {
  const read = async () => {
    throw new Error('not called');
  };
  assert.equal((await priceResult(records, null, '0xo', '09/08/2026', read)).status, 400);
  const missing = await priceResult(records, null, '0xo', '2020-01-01', read);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, {
    error: 'No Texas power price for 2020-01-01.',
    availableFrom: '2026-09-07',
    availableTo: '2026-09-08',
  });
});

void test('the board is read in one multicall and keeps only Texas power price markets, in site order', async () => {
  const hbNorth = keccak256(toBytes('ERCOT_HBNORTH_DA_AVG'));
  const basis = keccak256(toBytes('ERCOT_WEST_NORTH_DA_BASIS'));
  const row = (metric: string, dayKey: number, strike: number) => [
    metric, dayKey, BigInt(strike), BigInt(LATER), '0xY', '0xN', false, false, false, E18 / 4n, 5n, 7n,
  ];
  const listed = [1, 2, 3].map((n) => ({
    market: `0x${String(n).padStart(40, '0')}` as Address,
    createTxHash: '0x01' as Hash,
  }));
  let calls = 0;
  const board = await readBoard(
    async (contracts) => {
      calls += 1;
      assert.equal(contracts.length, 36);
      return [...row(hbNorth, 20260926, 4000), ...row(basis, 20260926, 0), ...row(hbNorth, 20260926, 4500)];
    },
    [] as Abi,
    listed,
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    board.map((m) => m.threshold),
    [4500, 4000],
  );
  assert.equal(board[0].yesReserve, 5n);
});

void test('markets list trading ones by default, in dollars, whole tokens and 0..1 prices', async () => {
  const board = [
    market(1, 20260926, 4000),
    market(2, 20260920, 3000, {
      resolveAfter: EARLIER,
      live: { resolved: true, cancelled: false, yesWon: true, priceE18: E18 },
    }),
  ];
  const trading = await marketsResult(null, NOW, async () => board);
  const rows = (trading.body as { markets: Record<string, unknown>[] }).markets;
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { ...rows[0], address: undefined, yesToken: undefined, noToken: undefined },
    {
      address: undefined,
      question: 'Will Texas power cost more than $40 on 26 Sep?',
      day: '2026-09-26',
      dayKey: 20260926,
      strike: 40,
      status: 'trading',
      yesPrice: 0.5,
      noPrice: 0.5,
      yesReserve: 1000,
      noReserve: 1000,
      tradingClosesAt: '2026-09-26T00:00:00.000Z',
      yesWon: null,
      yesToken: undefined,
      noToken: undefined,
    },
  );
  const all = await marketsResult('all', NOW, async () => board);
  const resolved = (all.body as { markets: Record<string, unknown>[] }).markets[1];
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.yesWon, true);
});

void test('a bad status is a 400 before any chain read, and a failed read a 503', async () => {
  const unread = async () => {
    throw new Error('should not read');
  };
  assert.equal((await marketsResult('open', NOW, unread)).status, 400);
  assert.equal((await marketsResult(null, NOW, unread)).status, 503);
});

void test('hedge parameters default, and a bad one is a 400 naming it', () => {
  assert.deepEqual(parseHedgeParams(new URLSearchParams()), {
    mw: 10,
    hours: 24,
    protectTo: 80,
    day: null,
  });
  const bad = (query: string) =>
    (parseHedgeParams(new URLSearchParams(query)) as { body: { error: string } }).body.error;
  assert.match(bad('mw=-1'), /^mw /);
  assert.match(bad('hours=25'), /^hours /);
  assert.match(bad('protectTo=abc'), /^protectTo /);
  assert.match(bad('day=2026-13-01'), /^day /);
});

void test('a hedge quote ladders the trading strikes of the earliest trading day by default', async () => {
  const board = [
    market(1, 20260927, 5000),
    market(2, 20260926, 4500),
    market(3, 20260926, 4000),
    market(4, 20260926, 3500, { live: { resolved: false, cancelled: true, yesWon: false, priceE18: 0n } }),
  ];
  const result = await hedgeQuoteResult(new URLSearchParams('mw=10&hours=24&protectTo=80'), NOW, async () => board);
  assert.equal(result.status, 200);
  const body = result.body as {
    day: string;
    mwh: number;
    rungs: { strike: number; tokens: number; cost: number; yesPrice: number }[];
    totalCost: number;
    scenarios: { price: number; extraCost: number; payout: number; covered: number | null }[];
  };
  assert.equal(body.day, '2026-09-26');
  assert.equal(body.mwh, 240);
  // The cancelled $35 market is not trading, so the ladder starts at $40.
  assert.deepEqual(
    body.rungs.map(({ strike, tokens }) => ({ strike, tokens })),
    [
      { strike: 40, tokens: 1200 },
      { strike: 45, tokens: 8400 },
    ],
  );
  // The cost of a rung buys back its tokens from the same 1,000/1,000 pool.
  assert.ok(Math.abs(yesOutFor(body.rungs[0].cost, 1000, 1000) - 1200) < 1e-4);
  assert.ok(Math.abs(body.totalCost - (body.rungs[0].cost + body.rungs[1].cost)) < 1e-6);
  assert.deepEqual(
    body.scenarios.map((s) => s.price),
    [40, 45, 80, 160],
  );
  assert.deepEqual(body.scenarios[2], { price: 80, extraCost: 9600, payout: 9600, covered: 1 });
  assert.equal(body.scenarios[3].covered, 0.3333);
});

void test('a hedge quote is a 404 listing trading days when none trade that day, and a 400 below the strikes', async () => {
  const board = [market(1, 20260926, 4000)];
  const none = await hedgeQuoteResult(new URLSearchParams('day=2026-09-30'), NOW, async () => board);
  assert.equal(none.status, 404);
  assert.deepEqual((none.body as { tradingDays: string[] }).tradingDays, ['2026-09-26']);
  const low = await hedgeQuoteResult(new URLSearchParams('protectTo=30'), NOW, async () => board);
  assert.equal(low.status, 400);
});
