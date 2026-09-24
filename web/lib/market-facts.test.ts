import assert from 'node:assert/strict';
import { test } from 'node:test';

import { marketName, type MarketFacts } from './market-facts.ts';

const market = (dayKey: number, threshold: number) =>
  ({ metricId: 'ERCOT_HBNORTH_DA_AVG', dayKey, threshold }) as MarketFacts;

void test('a market this year is named by day and month; one in an earlier year also by year', () => {
  assert.equal(marketName(market(20261002, 4500), 2026), 'Will Texas power cost more than $45 on 2 Oct?');
  assert.equal(
    marketName(market(20250911, 2500), 2026),
    'Will Texas power cost more than $25 on 11 Sep 2025?',
  );
});
