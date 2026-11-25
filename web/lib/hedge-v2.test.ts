import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  dailyEnergy,
  hedgePayoff,
  optionHedge,
  perpHedge,
  scenarios,
} from './hedge-v2.ts';

const BAND = { floor: -50, cap: 300 };
const miner = { role: 'buyer' as const, mw: 10, hoursPerDay: 24, share: 1 };
const solar = { role: 'producer' as const, mw: 50, hoursPerDay: 8, share: 0.5 };

void test('energy is megawatts times hours, and only the chosen share is hedged', () => {
  assert.deepEqual(dailyEnergy(miner), { mwh: 240, hedgedMwh: 240 });
  assert.deepEqual(dailyEnergy(solar), { mwh: 400, hedgedMwh: 200 });
  assert.deepEqual(dailyEnergy({ ...miner, hoursPerDay: 25 }), {
    mwh: 0,
    hedgedMwh: 0,
  });
  assert.deepEqual(dailyEnergy({ ...miner, share: 1.5 }), {
    mwh: 0,
    hedgedMwh: 0,
  });
});

void test('a buyer locks a price by going long; the collateral is the loss down to the floor', () => {
  const hedge = perpHedge(miner, 44, BAND);
  assert.equal(hedge.side, 'long');
  assert.equal(hedge.collateral, 240 * 94); // $22,560
  const [atHundred] = scenarios(miner, hedge, [100], BAND);
  assert.equal(atHundred.unhedged, 24_000);
  assert.equal(atHundred.hedged, 240 * 44); // the bill is locked at $44
});

void test('a producer locks revenue by going short; the collateral is the loss up to the cap', () => {
  const hedge = perpHedge(solar, 30, BAND);
  assert.equal(hedge.side, 'short');
  assert.equal(hedge.collateral, 200 * 270);
  const [atTen] = scenarios(solar, hedge, [10], BAND);
  // half the output earns the market $10, the hedged half keeps $30
  assert.equal(atTen.hedged, 400 * 10 + 200 * 20);
});

void test('calls cap a buyer at strike plus premium, and cost only the premium on calm days', () => {
  const hedge = optionHedge(miner, 60, 1.5);
  assert.equal(hedge.premium, 360);
  assert.equal(hedge.effectivePrice, 61.5);
  const [calm, spike] = scenarios(miner, hedge, [30, 100], BAND);
  assert.equal(calm.hedged, 240 * 30 + 360);
  assert.equal(spike.hedged, 240 * 61.5);
});

void test('puts set a producer a floor at strike minus premium', () => {
  const hedge = optionHedge(solar, 25, 2);
  assert.equal(hedge.effectivePrice, 23);
  const [crash] = scenarios(solar, hedge, [0], BAND);
  assert.equal(crash.hedged, 200 * 23); // hedged half floored at $23, unhedged half earns $0
});

void test('beyond the band the hedge stops paying more', () => {
  const call = optionHedge(miner, 60, 1.5);
  assert.equal(hedgePayoff(call, 1000, BAND), 240 * (300 - 60) - 360);
  const long = perpHedge(miner, 44, BAND);
  const [scarcity] = scenarios(miner, long, [1000], BAND);
  assert.equal(scarcity.hedged, 240 * 1000 - 240 * (300 - 44)); // only the band's part is hedged
});
