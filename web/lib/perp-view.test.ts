import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  dollars,
  mwhLabel,
  perpTicket,
  positionAt,
  priceCents,
  sizeUnits,
} from './perp-view.ts';

const BAND = { floorCents: -5000, capCents: 30_000 };

void test('sizes and prices are read exactly as typed, or refused', () => {
  assert.equal(sizeUnits('10'), 10_000n);
  assert.equal(sizeUnits('0.1'), 100n);
  assert.equal(sizeUnits('2.125'), 2125n);
  assert.equal(sizeUnits('1.2345'), null);
  assert.equal(sizeUnits('abc'), null);
  assert.equal(priceCents('44.33'), 4433);
  assert.equal(priceCents('-12.5'), -1250);
  assert.equal(priceCents('4.333'), null);
});

void test('the ticket matches what the contract escrows and posts (the contract tests use the same order)', () => {
  // TexasPowerPerpTest.testLongFillsAtTheNextPrintAndRefundsTheSpareEscrow:
  // long 10 MWh, limit $45, fill at $44.33, fee 10 bps
  const t = perpTicket({
    side: 'long',
    size: 10_000n,
    limitCents: 4500,
    indexCents: 4433,
    band: BAND,
    feeBps: 10,
    freePool: 10n ** 13n,
  });
  assert.equal(t.escrow, 950_000_000n + 3_000_000n);
  assert.equal(t.collateralAtIndex, 943_300_000n);
  assert.equal(t.maxGainAtIndex, 2_556_700_000n);
  assert.equal(t.feeAtIndex, 443_300n);
  assert.equal(t.poolNeeded, 3_500_000_000n);
  assert.equal(t.problem, null);
});

void test('a short posts the move up to the cap', () => {
  const t = perpTicket({
    side: 'short',
    size: 5000n,
    limitCents: 4300,
    indexCents: 4433,
    band: BAND,
    feeBps: 10,
    freePool: 10n ** 13n,
  });
  assert.equal(t.collateralAtIndex, 1_278_350_000n);
  assert.equal(t.maxGainAtIndex, 471_650_000n);
});

void test('the ticket says why an order would be refused', () => {
  const base = {
    side: 'long' as const,
    size: 10_000n,
    limitCents: 4500,
    indexCents: 4433,
    band: BAND,
    feeBps: 10,
    freePool: 10n ** 13n,
  };
  assert.match(perpTicket({ ...base, size: 99n }).problem!, /at least 0.1 MWh/);
  assert.match(
    perpTicket({ ...base, limitCents: 30_000 }).problem!,
    /inside \$-50 to \$300/,
  );
  assert.match(
    perpTicket({ ...base, limitCents: null }).problem!,
    /limit price/,
  );
  assert.match(
    perpTicket({ ...base, freePool: 1n }).problem!,
    /pool cannot cover/,
  );
});

void test('a position is valued like the contract closes it, clamped to the band', () => {
  const position = {
    isLong: true,
    entryPriceCents: 4433,
    size: 10_000n,
    collateral: 943_300_000n,
    reserve: 2_556_700_000n,
  };
  const at52 = positionAt(position, 5200, BAND, 10);
  assert.equal(at52.pnl, 76_700_000n);
  assert.equal(at52.closeFee, 520_000n);
  assert.equal(at52.payout, 943_300_000n + 76_700_000n - 520_000n);
  assert.equal(positionAt(position, 90_000, BAND, 10).pnl, 2_556_700_000n); // capped at the reserve
  assert.equal(positionAt(position, -20_000, BAND, 10).payout, 0n); // never below zero
});

void test('amounts read as dollars and MWh', () => {
  assert.equal(dollars(943_300_000n), '$943.30');
  assert.equal(dollars(1_234_567_890_000n), '$1,234,567.89');
  assert.equal(dollars(-520_000n), '-$0.52');
  assert.equal(mwhLabel(10_500n), '10.5 MWh');
  assert.equal(mwhLabel(100n), '0.1 MWh');
});
