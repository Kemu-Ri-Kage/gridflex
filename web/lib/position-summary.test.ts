import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  oppositeBuyWarning,
  pairsLabel,
  paysLabel,
  positionSummary,
} from './position-summary.ts';

const units = (n: number) => BigInt(n) * 1_000_000n;

void test('no holding, no summary', () => {
  assert.equal(positionSummary(0n, 0n), undefined);
});

void test('one side held is all net, no pairs', () => {
  assert.deepEqual(positionSummary(units(192), 0n), {
    yes: units(192),
    no: 0n,
    pairs: 0n,
    net: { side: 'YES', amount: units(192) },
  });
});

void test('both sides held net into matched pairs plus the rest', () => {
  const summary = positionSummary(units(192), units(150));
  assert.equal(summary?.pairs, units(150));
  assert.deepEqual(summary?.net, { side: 'YES', amount: units(42) });
  assert.equal(
    pairsLabel(units(150)),
    '150 mUSDT at settlement, either outcome',
  );
});

void test('equal sides are all pairs, with no net side', () => {
  const summary = positionSummary(units(100), units(100));
  assert.equal(summary?.pairs, units(100));
  assert.equal(summary?.net, undefined);
});

void test('YES pays only strictly above the strike; NO at or below it', () => {
  assert.equal(
    paysLabel('YES', units(192), '$45'),
    'Pays 192 mUSDT if above $45 · else 0',
  );
  assert.equal(
    paysLabel('NO', units(42), '$45'),
    'Pays 42 mUSDT if $45 or below · else 0',
  );
});

void test('buying against the net side warns; adding to it does not', () => {
  const summary = positionSummary(units(192), 0n);
  assert.equal(
    oppositeBuyWarning(summary, 'NO'),
    "Opens NO beside your 192 YES; doesn't sell it.",
  );
  assert.equal(oppositeBuyWarning(summary, 'YES'), undefined);
  assert.equal(oppositeBuyWarning(undefined, 'NO'), undefined);
  // All pairs: no side to open against.
  assert.equal(
    oppositeBuyWarning(positionSummary(units(50), units(50)), 'YES'),
    undefined,
  );
});
