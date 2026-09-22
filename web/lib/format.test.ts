import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatUpdated } from './format.ts';

void test('formatUpdated: Texas summer time and UTC', () => {
  assert.equal(
    formatUpdated('2026-09-22T11:03:32Z'),
    '22 Sep 2026, 06:03 CDT (Texas) · 11:03 UTC',
  );
});

void test('formatUpdated: Texas winter time and UTC', () => {
  assert.equal(
    formatUpdated('2026-12-01T18:30:00Z'),
    '1 Dec 2026, 12:30 CST (Texas) · 18:30 UTC',
  );
});

void test('formatUpdated: repeats the UTC date when it has already rolled over', () => {
  assert.equal(
    formatUpdated('2026-09-23T03:15:00Z'),
    '22 Sep 2026, 22:15 CDT (Texas) · 23 Sep 2026, 03:15 UTC',
  );
});

void test('formatUpdated: accepts Python isoformat with microseconds and an offset', () => {
  assert.equal(
    formatUpdated('2026-09-21T21:35:55.518448+00:00'),
    '21 Sep 2026, 16:35 CDT (Texas) · 21:35 UTC',
  );
});

void test('formatUpdated: missing or unparseable input gives null', () => {
  assert.equal(formatUpdated(null), null);
  assert.equal(formatUpdated(undefined), null);
  assert.equal(formatUpdated(''), null);
  assert.equal(formatUpdated('not a date'), null);
});
