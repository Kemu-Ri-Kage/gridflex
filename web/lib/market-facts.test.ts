import assert from 'node:assert/strict';
import { test } from 'node:test';

import { marketName, shownYesPriceE18, type MarketFacts } from './market-facts.ts';

const market = (dayKey: number, threshold: number) =>
  ({ metricId: 'ERCOT_HBNORTH_DA_AVG', dayKey, threshold }) as MarketFacts;

void test('a market this year is named by day and month; one in an earlier year also by year', () => {
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
