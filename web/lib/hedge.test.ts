import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dailyMwh, extraCost, ladder, ladderPayout, scenarios, yesCostFor, yesOutFor } from './hedge.ts';

void test('a load uses its megawatts times its hours each day, never more than 24 hours', () => {
  assert.equal(dailyMwh(10), 240);
  assert.equal(dailyMwh(10, 12), 120);
  assert.equal(dailyMwh(10, 25), 0);
  assert.equal(dailyMwh(0), 0);
  assert.equal(dailyMwh(-5), 0);
});

void test('each rung holds the MWh times the gap to the next rung, the last one to the protected price', () => {
  // 240 MWh, strikes $40 and $45, protected to $80
  assert.deepEqual(ladder(240, [45, 40, 45], 80), [
    { strike: 40, tokens: 240 * 5 },
    { strike: 45, tokens: 240 * 35 },
  ]);
  // a strike at or above the protected price adds nothing
  assert.deepEqual(ladder(240, [40, 90], 80), [{ strike: 40, tokens: 240 * 40 }]);
  assert.deepEqual(ladder(0, [40], 80), []);
});

void test('the ladder pays the extra cost above its lowest strike, in steps, up to the protected price', () => {
  const rungs = ladder(240, [40, 45], 80);
  assert.equal(ladderPayout(rungs, 40), 0); // strictly above, as the contract settles
  assert.equal(ladderPayout(rungs, 44), 1200); // the $40 rung: 240 x 5
  assert.equal(ladderPayout(rungs, 80), 240 * 40); // both rungs: the full $40 -> $80 gap
  assert.equal(ladderPayout(rungs, 200), 240 * 40); // capped at the protected price
  assert.equal(extraCost(240, 80, 40), 240 * 40);
  assert.equal(extraCost(240, 30, 40), 0);
});

void test('scenarios compare the extra cost with the payout at each price', () => {
  const rungs = ladder(100, [40, 50], 60);
  assert.deepEqual(scenarios(100, rungs, [35, 60, 100]), [
    { price: 35, extraCost: 0, payout: 0, covered: null },
    { price: 60, extraCost: 2000, payout: 2000, covered: 1 },
    { price: 100, extraCost: 6000, payout: 2000, covered: 2000 / 6000 },
  ]);
});

void test('the cost of a YES buy inverts the pool output exactly', () => {
  // an even 1,000 / 1,000 pool: 100 mUSDT buys 100 + 1000 x 100 / 1100 YES
  assert.ok(Math.abs(yesOutFor(100, 1000, 1000) - (100 + 100000 / 1100)) < 1e-9);
  for (const [tokens, yes, no] of [
    [50, 1000, 1000],
    [8400, 1000, 1000],
    [10, 5000, 200],
  ]) {
    const amount = yesCostFor(tokens, yes, no);
    assert.ok(Math.abs(yesOutFor(amount, yes, no) - tokens) < 1e-6, `${tokens} YES from ${yes}/${no}`);
    // never cheaper than the pool's marginal price, never dearer than 1 mUSDT each
    assert.ok(amount <= tokens);
    assert.ok(amount >= (tokens * no) / (yes + no) - 1e-9);
  }
  assert.equal(yesCostFor(0, 1000, 1000), 0);
  assert.equal(yesCostFor(10, 0, 1000), 0);
});
