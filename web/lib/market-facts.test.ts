import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  contractLabel,
  instrumentCode,
  instrumentName,
  marketName,
  payLine,
  shownYesPriceE18,
  statusLabel,
  type Market,
  type MarketFacts,
} from './market-facts.ts';

const market = (dayKey: number, threshold: number) =>
  ({ metricId: 'ERCOT_HBNORTH_DA_AVG', dayKey, threshold }) as MarketFacts;

void test('the machine API question keeps its wording: day and month, plus the year for an earlier year', () => {
  assert.equal(marketName(market(20261002, 4500), 2026), 'Will Texas power cost more than $45 on 2 Oct?');
  assert.equal(
    marketName(market(20250911, 2500), 2026),
    'Will Texas power cost more than $25 on 11 Sep 2025?',
  );
});

void test('a settled market shows what each YES paid, not its frozen pool price', () => {
  const E18 = 10n ** 18n;
  const live = { resolved: false, cancelled: false, yesWon: false, priceE18: E18 / 2n };
  assert.equal(shownYesPriceE18(live), E18 / 2n);
  assert.equal(shownYesPriceE18({ ...live, priceE18: 3n * (E18 / 10n) }), 3n * (E18 / 10n));
  assert.equal(shownYesPriceE18({ ...live, resolved: true, yesWon: true }), E18);
  assert.equal(shownYesPriceE18({ ...live, resolved: true, yesWon: false }), 0n);
  assert.equal(shownYesPriceE18({ ...live, cancelled: true, priceE18: 9n * (E18 / 10n) }), E18 / 2n);
});

void test('the site names a market as an instrument: headline, code line and list label', () => {
  assert.equal(instrumentName(market(20261014, 5000)), 'Texas Power · $50 strike');
  assert.equal(instrumentCode(market(20261014, 5000)), 'TX-POWER · 14 OCT 2026 · DAILY');
  assert.equal(contractLabel(market(20261014, 5000), 2026), 'Texas Power · 14 Oct · $50 strike');
  assert.equal(contractLabel(market(20250911, 2500), 2026), 'Texas Power · 11 Sep 2025 · $25 strike');
  const spread = { metricId: 'ERCOT_WEST_NORTH_DA_BASIS', dayKey: 20261014, threshold: 400 } as MarketFacts;
  assert.equal(instrumentName(spread), 'West–North spread · +$4 strike');
  assert.equal(instrumentCode(spread), 'TX-WN-SPREAD · 14 OCT 2026 · DAILY');
});

void test('the payout rule: Long strictly above the strike, Short at or below it', () => {
  assert.equal(
    payLine(market(20261014, 5000), 2026),
    'Long pays 1 mUSDT per contract if 14 Oct settles above $50.00/MWh. Short pays if it settles at or below.',
  );
  assert.equal(
    payLine({ metricId: 'ERCOT_WEST_NORTH_DA_BASIS', dayKey: 20261014, threshold: 400 }, 2026),
    'Long pays 1 mUSDT per contract if the 14 Oct West–North spread settles above +$4.00/MWh. Short pays if it settles at or below.',
  );
});

void test('a settled market names the side that paid', () => {
  const live = { resolved: true, cancelled: false, yesWon: true, priceE18: 0n };
  const settled = { ...market(20260930, 3500), resolveAfter: 0, live } as Market;
  assert.equal(statusLabel(settled, 0), 'Settled · Long');
  assert.equal(statusLabel({ ...settled, live: { ...live, yesWon: false } }, 0), 'Settled · Short');
});
