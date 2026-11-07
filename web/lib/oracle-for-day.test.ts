import assert from 'node:assert/strict';
import { test } from 'node:test';

import { oracleForDay } from './oracle-for-day.ts';

void test('every day is on the current oracle until one is retired', () => {
  assert.equal(oracleForDay({ GridOracle: '0xnew' }, 20261020), '0xnew');
  assert.equal(oracleForDay({ GridOracle: '0xnew', retiredOracles: [] }, 20261020), '0xnew');
});

void test('days up to a retired oracle’s last day are read from it', () => {
  const addresses = {
    GridOracle: '0xv3',
    retiredOracles: [
      { address: '0xv2', lastDayKey: 20261231 },
      { address: '0xv1', lastDayKey: 20261020 },
    ],
  };
  assert.equal(oracleForDay(addresses, 20260908), '0xv1');
  assert.equal(oracleForDay(addresses, 20261020), '0xv1');
  assert.equal(oracleForDay(addresses, 20261021), '0xv2');
  assert.equal(oracleForDay(addresses, 20261231), '0xv2');
  assert.equal(oracleForDay(addresses, 20270101), '0xv3');
});
