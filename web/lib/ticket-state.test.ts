import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ticketState } from './ticket-state.ts';

const MARKET = '0xb1FaDd618FFC37E26bf75143E6C852d6D3992F94';
const CLOSE = 1_790_357_400; // 25 Sep 2026 12:30 Texas time
const WEEK = 604_800;

function snapshot(overrides: Partial<Parameters<typeof ticketState>[0]> = {}) {
  return {
    address: MARKET,
    loaded: true,
    resolved: false,
    cancelled: false,
    resolveAfter: CLOSE,
    disputeWindow: WEEK,
    ...overrides,
  };
}

void test('trading is open before resolveAfter', () => {
  const state = ticketState(snapshot(), MARKET, CLOSE - 1);
  assert.equal(state.tradingOpen, true);
  assert.equal(state.closed, false);
  assert.equal(state.cancellable, false);
});

void test('resolveAfter is the trading cut-off and the earliest resolve time', () => {
  const state = ticketState(snapshot(), MARKET, CLOSE);
  assert.equal(state.tradingOpen, false);
  assert.equal(state.closed, true);
  assert.equal(state.cancellable, false);
});

void test('cancel opens only after the dispute window', () => {
  assert.equal(
    ticketState(snapshot(), MARKET, CLOSE + WEEK - 1).cancellable,
    false,
  );
  assert.equal(ticketState(snapshot(), MARKET, CLOSE + WEEK).cancellable, true);
});

void test('a settled market never trades again', () => {
  const state = ticketState(snapshot({ resolved: true }), MARKET, CLOSE + 10);
  assert.equal(state.settled, true);
  assert.equal(state.tradingOpen, false);
});

void test('a snapshot read for another market is not ready', () => {
  const other = '0x204Ef0871892c52b7Abf00AC4755333c5e7F73af';
  const state = ticketState(snapshot({ address: other }), MARKET, CLOSE - 1);
  assert.equal(state.ready, false);
  assert.equal(state.tradingOpen, false);
});

void test('address comparison ignores checksum case', () => {
  const state = ticketState(
    snapshot({ address: MARKET.toLowerCase() }),
    MARKET,
    CLOSE - 1,
  );
  assert.equal(state.ready, true);
});

void test('nothing is possible before the first read or with no market', () => {
  assert.equal(
    ticketState(snapshot({ loaded: false }), MARKET, CLOSE - 1).ready,
    false,
  );
  assert.equal(ticketState(snapshot(), undefined, CLOSE - 1).ready, false);
});
