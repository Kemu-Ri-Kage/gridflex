import assert from 'node:assert/strict';
import { test } from 'node:test';

import { byTerm, termOf } from './market-term.ts';

const NOW = Date.UTC(2026, 8, 24, 22, 0); // 24 Sep 22:00 UTC
const closeIn = (hours: number) => NOW / 1000 + hours * 3600;

void test('trading markets group by how soon they close', () => {
  assert.equal(termOf('trading', closeIn(19.5), NOW), 'next'); // 26 Sep, closes 25 Sep 17:30 UTC
  assert.equal(termOf('trading', closeIn(43.5), NOW), 'week');
  assert.equal(termOf('trading', closeIn(24 * 8), NOW), 'later');
  assert.equal(termOf('awaiting', closeIn(-2), NOW), 'awaiting');
  assert.equal(termOf('resolved', closeIn(-500), NOW), 'settled');
  assert.equal(termOf('cancelled', closeIn(-500), NOW), 'settled');
});

void test('the list reads soonest first, a ladder top to bottom, settled last and newest first', () => {
  const m = (term: 'next' | 'week' | 'settled', hours: number, dayKey: number, threshold: number) => ({
    term,
    resolveAfter: closeIn(hours),
    dayKey,
    threshold,
  });
  const ordered = byTerm([
    m('settled', -900, 20260908, 3000),
    m('week', 43, 20260927, 3500),
    m('next', 19, 20260926, 3500),
    m('week', 43, 20260927, 4500),
    m('settled', -500, 20260926, 4500),
    m('next', 19, 20260926, 4500),
  ]);
  assert.deepEqual(
    ordered.map((x) => `${x.dayKey}:${x.threshold}`),
    ['20260926:4500', '20260926:3500', '20260927:4500', '20260927:3500', '20260926:4500', '20260908:3000'],
  );
});
