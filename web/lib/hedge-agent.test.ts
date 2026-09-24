import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_BASE,
  MIN_GAS_WEI,
  buyUnits,
  marketsLine,
  nextTradingDay,
  parseAgentArgs,
  planLines,
  preflightProblems,
  priceLine,
  receiptLine,
  type HedgeAnswer,
} from './hedge-agent.ts';

void test('the agent defaults to a 10 MW, 24-hour load protected to $80, and sends nothing', () => {
  assert.deepEqual(parseAgentArgs([]), {
    base: DEFAULT_BASE,
    mw: 10,
    hours: 24,
    day: null,
    protectTo: 80,
    execute: false,
    fund: false,
  });
  assert.deepEqual(
    parseAgentArgs(['--base', 'http://localhost:5301/', '--mw', '5', '--day', '2026-09-30', '--protect-to', '60', '--execute']),
    {
      base: 'http://localhost:5301',
      mw: 5,
      hours: 24,
      day: '2026-09-30',
      protectTo: 60,
      execute: true,
      fund: false,
    },
  );
  assert.throws(() => parseAgentArgs(['--hours', '30']), /--hours/);
  assert.throws(() => parseAgentArgs(['--day', 'tomorrow']), /--day/);
  assert.throws(() => parseAgentArgs(['--buy']), /Unknown option/);
});

void test('the next trading day is the earliest one after today', () => {
  const markets = [
    { day: '2026-09-30', status: 'trading' as const },
    { day: '2026-09-26', status: 'trading' as const },
    { day: '2026-09-24', status: 'trading' as const },
    { day: '2026-09-25', status: 'awaiting' as const },
  ];
  assert.equal(nextTradingDay(markets, '2026-09-24'), '2026-09-26');
  assert.equal(nextTradingDay(markets, '2026-09-30'), null);
});

void test('a paid verified price names the payment, the price, the day and the oracle transaction', () => {
  const verified = {
    day: '2026-09-08',
    valueCents: 3957,
    verified: true,
    oracle: { published: true, txHash: '0xf6bdfc4e4c775eca150fff4d380f915411d6bf4e5389d8e3228dfbeff00cb44f', checked: true },
  };
  assert.equal(
    priceLine({ paid: true, tx: '0xabc' }, verified),
    'Paid $0.01 in USDT0 on X Layer for the verified Texas power price: $39.57/MWh on 8 Sep 2026 (oracle tx 0xf6bdfc…cb44f)',
  );
  assert.equal(receiptLine({ paid: true, tx: '0xabc' }), '  payment settled in tx 0xabc');
  assert.equal(receiptLine({ paid: false }), null);
  // Never "verified" unless the API says so.
  assert.equal(
    priceLine({ paid: false }, { ...verified, verified: false, oracle: { published: false, txHash: null, checked: true } }),
    "Free call (the API isn't charging yet) for the Texas power price: $39.57/MWh on 8 Sep 2026 (not yet published to the oracle)",
  );
});

void test('the markets line counts trading markets and lists the chosen day\'s strikes', () => {
  const markets = [
    { day: '2026-09-30', strike: 45, status: 'trading' as const },
    { day: '2026-09-30', strike: 40, status: 'trading' as const },
    { day: '2026-09-08', strike: 30, status: 'resolved' as const },
  ];
  assert.equal(
    marketsLine({ paid: false }, markets, '2026-09-30'),
    "Free call (the API isn't charging yet) for the markets: 2 trading; 30 Sep 2026 has strikes $40, $45",
  );
});

void test('the plan prints each rung and each settlement price in aligned columns', () => {
  const quote: HedgeAnswer = {
    day: '2026-09-30',
    mw: 10,
    hours: 24,
    mwh: 240,
    protectTo: 80,
    rungs: [
      { market: '0x1', strike: 40, tokens: 1200, yesPrice: 0.5, cost: 617.983829 },
      { market: '0x2', strike: 45, tokens: 8400, yesPrice: 0.5005, cost: 5050.066799 },
    ],
    totalCost: 5668.050628,
    scenarios: [
      { price: 40, extraCost: 0, payout: 0, covered: null },
      { price: 160, extraCost: 28800, payout: 9600, covered: 0.3333 },
    ],
    notes: [],
  };
  const lines = planLines(quote);
  assert.equal(lines[0], 'Hedge plan: 240 MWh on 30 Sep 2026, protected up to $80/MWh');
  assert.equal(lines[1], 'Strike    YES to buy   YES price   Cost (mUSDT)');
  assert.equal(lines[3], '$40/MWh     1,200.00       50.0¢         617.98');
  assert.equal(lines[5], 'Total: 5,668.05 mUSDT (indicative)');
  assert.equal(lines.at(-1), '$160/MWh     $28,800.00   9,600.00 mUSDT       33%');
});

void test('a rung buys with its cost in 6-decimal mUSDT units', () => {
  assert.equal(buyUnits(617.983829), 617_983_829n);
  assert.equal(buyUnits(0.1), 100_000n);
});

void test('the agent stops before buying without gas or enough mUSDT, and says what to do', () => {
  assert.deepEqual(preflightProblems('0xA', MIN_GAS_WEI, 2_000_000_000n, 1_000_000_000n), []);
  const [gas, funds] = preflightProblems('0xA', 0n, 0n, 5_668_050_628n);
  assert.match(gas, /0xA needs at least 0\.001 OKB/);
  assert.match(funds, /needs 5,668.05 mUSDT and the agent wallet holds 0\. Run with --fund/);
});
