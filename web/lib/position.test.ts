import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildLedger,
  findChangeBlocks,
  markE18,
  positionRows,
  swapIsBuyLeg,
  type PositionEvent,
} from './position.ts';

const E18 = 10n ** 18n;
const HALF = E18 / 2n;
const open = {
  priceE18: HALF,
  resolved: false,
  cancelled: false,
  yesWon: false,
};

// The first demo trade (shared/demo-evidence.md): mintSet(10 mUSDT), then
// 10 NO swapped for 9.990009 YES.
const demoBuy: PositionEvent[] = [
  { kind: 'mint', amount: 10_000_000n },
  {
    kind: 'swap',
    yesForNo: false,
    amountIn: 10_000_000n,
    amountOut: 9_990_009n,
  },
];

void test('a buy is a mint plus a swap of the same amount', () => {
  assert.deepEqual(swapIsBuyLeg(demoBuy), [true]);
  const ledger = buildLedger(demoBuy);
  assert.equal(ledger.undetermined, undefined);
  assert.deepEqual(ledger.YES, { quantity: 19_990_009n, cost: 10_000_000n });
  assert.deepEqual(ledger.NO, { quantity: 0n, cost: 0n });
});

void test('the demo position: entry, value and indicative P&L', () => {
  const [row] = positionRows(
    { YES: 19_990_009n, NO: 0n },
    { ...open, priceE18: 600_000_000_000_000_000n },
    buildLedger(demoBuy),
  );
  assert.equal(row.side, 'YES');
  assert.equal(row.cost, 10_000_000n);
  // 10 / 19.990009 = 0.50025 mUSDT per YES.
  assert.equal(row.averageEntryE18, (10_000_000n * E18) / 19_990_009n);
  assert.equal(row.value, 11_994_005n); // 19.990009 x 0.60
  assert.equal(row.pnl, 1_994_005n);
  assert.ok(Math.abs((row.pnlFraction ?? 0) - 0.1994005) < 1e-9);
});

void test('a switch carries cost to the side received and is not a buy', () => {
  const events: PositionEvent[] = [
    ...demoBuy,
    {
      kind: 'swap',
      yesForNo: true,
      amountIn: 4_997_502n,
      amountOut: 5_100_000n,
    },
  ];
  assert.deepEqual(swapIsBuyLeg(events), [true, false]);
  const ledger = buildLedger(events);
  assert.equal(ledger.undetermined, undefined);
  assert.equal(ledger.YES.quantity, 14_992_507n);
  assert.equal(ledger.NO.quantity, 5_100_000n);
  // A quarter of the YES cost moved to NO; total cost is unchanged.
  assert.equal(ledger.NO.cost, (10_000_000n * 4_997_502n) / 19_990_009n);
  assert.equal(ledger.YES.cost + ledger.NO.cost, 10_000_000n);
});

void test('a pair that was never swapped leaves the entry undetermined', () => {
  const ledger = buildLedger([{ kind: 'mint', amount: 5_000_000n }]);
  assert.equal(ledger.undetermined, 'pair');
  const rows = positionRows({ YES: 5_000_000n, NO: 5_000_000n }, open, ledger);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.undetermined, 'pair');
    assert.equal(row.averageEntryE18, undefined);
    assert.equal(row.pnl, undefined);
    assert.equal(row.value, 2_500_000n); // current value is still shown
  }
});

void test('a balance the trades do not explain is a transfer', () => {
  const rows = positionRows(
    { YES: 25_000_000n, NO: 0n },
    open,
    buildLedger(demoBuy),
  );
  assert.equal(rows[0].undetermined, 'transfer');
  assert.equal(buildLedger([{ kind: 'transfer' }]).undetermined, 'transfer');
  // Switching tokens that never arrived through a trade.
  assert.equal(
    buildLedger([
      {
        kind: 'swap',
        yesForNo: true,
        amountIn: 1_000_000n,
        amountOut: 900_000n,
      },
    ]).undetermined,
    'transfer',
  );
});

void test('unreadable history shows value only', () => {
  const [row] = positionRows({ YES: 1_000_000n, NO: 0n }, open, {
    undetermined: 'history',
  });
  assert.equal(row.undetermined, 'history');
  assert.equal(row.value, 500_000n);
});

void test('redeemed tokens leave the ledger', () => {
  const ledger = buildLedger([
    ...demoBuy,
    { kind: 'redeem', yesBurned: 19_990_009n, noBurned: 0n },
  ]);
  assert.deepEqual(ledger.YES, { quantity: 0n, cost: 0n });
});

void test('marks: pool price while open, payout once settled', () => {
  const price = 620_000_000_000_000_000n;
  assert.equal(markE18('YES', { ...open, priceE18: price }), price);
  assert.equal(markE18('NO', { ...open, priceE18: price }), E18 - price);
  const yesWon = { ...open, resolved: true, yesWon: true };
  assert.equal(markE18('YES', yesWon), E18);
  assert.equal(markE18('NO', yesWon), 0n);
  assert.equal(markE18('NO', { ...open, cancelled: true }), HALF);
});

void test('findChangeBlocks finds each block where the probe changes', async () => {
  const changes = [1_000n, 1_009n, 40_000n];
  let calls = 0;
  const probe = async (block: bigint) => {
    calls += 1;
    return String(changes.filter((c) => c <= block).length);
  };
  assert.deepEqual(await findChangeBlocks(probe, 0n, 44_000n), changes);
  assert.ok(calls < 60, `took ${calls} probes`);
  assert.deepEqual(await findChangeBlocks(probe, 50_000n, 60_000n), []);
  assert.deepEqual(await findChangeBlocks(probe, 5n, 5n), []);
});
