import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bachelierCall,
  bachelierPut,
  bandedCall,
  bandedPut,
  erf,
  forwardAndSigma,
  normalCdf,
  quoteStrike,
  strikesAround,
} from './option-pricing.ts';

const BAND = { floor: -50, cap: 300 };
const close = (a: number, b: number, tolerance = 1e-6) =>
  assert.ok(
    Math.abs(a - b) <= tolerance,
    `${a} is not within ${tolerance} of ${b}`,
  );

void test('the normal distribution matches known values', () => {
  close(erf(0), 0, 1e-8);
  close(erf(1), 0.8427007929, 2e-7);
  close(erf(-1), -0.8427007929, 2e-7);
  close(normalCdf(0), 0.5, 1e-8);
  close(normalCdf(1.959964), 0.975, 2e-7);
  close(normalCdf(-1.959964), 0.025, 2e-7);
});

void test('an at-the-money call is worth sigma / sqrt(2 pi)', () => {
  close(bachelierCall(44, 44, 10), 10 / Math.sqrt(2 * Math.PI));
});

void test('calls and puts obey put-call parity, and deep options are worth their intrinsic value', () => {
  for (const strike of [20, 40, 44, 60, 90]) {
    close(
      bachelierCall(44, strike, 8) - bachelierPut(44, strike, 8),
      44 - strike,
    );
  }
  close(bachelierCall(100, 40, 5), 60, 1e-6);
  close(bachelierPut(100, 40, 5), 0, 1e-6);
  assert.equal(bachelierCall(44, 40, 0), 4);
});

void test('banded options never cost more than their largest payout', () => {
  // a very uncertain day: the plain call would be worth more than $255
  const call = bandedCall(250, 45, 400, BAND);
  assert.ok(call <= 255 && call > 0);
  const put = bandedPut(-40, 40, 400, BAND);
  assert.ok(put <= 90 && put > 0);
  // with ordinary uncertainty the band barely matters
  close(bandedCall(44, 45, 8, BAND), bachelierCall(44, 45, 8), 1e-6);
});

void test('nine $5 strikes around the forward, kept inside the band', () => {
  assert.deepEqual(
    strikesAround(44.23, BAND),
    [25, 30, 35, 40, 45, 50, 55, 60, 65],
  );
  assert.deepEqual(strikesAround(-45, BAND), [-45, -40, -35, -30, -25]);
  assert.deepEqual(strikesAround(298, BAND), [280, 285, 290, 295]);
});

void test('quotes are whole cents the contract accepts, with the pool earning the spread', () => {
  for (const strike of strikesAround(44.23, BAND)) {
    const q = quoteStrike(44.23, strike, 9, BAND);
    for (const v of Object.values(q)) assert.ok(Number.isInteger(v) && v >= 0);
    assert.ok(q.callBid <= q.callAsk && q.putBid <= q.putAsk);
    assert.ok(q.callAsk >= 1 && q.callAsk <= (300 - strike) * 100);
    assert.ok(q.putAsk >= 1 && q.putAsk <= (strike + 50) * 100);
    const callMid = bandedCall(44.23, strike, 9, BAND) * 100;
    assert.ok(q.callAsk > callMid && q.callBid < callMid);
  }
  // a near-the-money $45 call at sigma $9: d = -0.77 / 9, worth
  // -0.77 x 0.4659 + 9 x 0.3975 = $3.2187, so ask $3.38 and bid $3.05 (5%);
  // the put is $3.2187 + $0.77 = $3.9887, so ask $4.19 and bid $3.78
  close(bandedCall(44.23, 45, 9, BAND), 3.2187, 1e-4);
  assert.deepEqual(quoteStrike(44.23, 45, 9, BAND), {
    callAsk: 338,
    callBid: 305,
    putAsk: 419,
    putBid: 378,
  });
});

void test('far out-of-the-money options ask at least a cent and bid nothing', () => {
  const q = quoteStrike(44, 290, 5, BAND);
  assert.equal(q.callAsk, 2);
  assert.equal(q.callBid, 0);
});

void test('the forward is the day-ahead average once known, else the recent mean', () => {
  assert.deepEqual(forwardAndSigma([30, 40, 50], 44.23), {
    forward: 44.23,
    sigma: 6,
  });
  const fromHistory = forwardAndSigma([10, 30, 40, 50], null, { window: 3 });
  assert.equal(fromHistory?.forward, 40);
  close(fromHistory!.sigma, 10);
  assert.equal(forwardAndSigma([44, 44, 44], null)?.sigma, 3); // never below the floor
  assert.equal(forwardAndSigma([44, 45], null), null);
});
