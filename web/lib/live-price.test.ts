import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cacheSeconds,
  isStale,
  liveQueryUrl,
  parseLiveRows,
  priceChange,
  texasClock,
} from './live-price.ts';

const row = (start: string, lmp: number | string) => ({
  interval_start_utc: start,
  interval_end_utc: new Date(Date.parse(start) + 300_000).toISOString(),
  lmp,
});

void test('the query asks GridStatus for the last 25 minutes of North Hub 5-minute prices', () => {
  const url = new URL(liveQueryUrl(Date.parse('2026-11-09T14:07:00Z')));
  assert.equal(
    url.origin + url.pathname,
    'https://api.gridstatus.io/v1/datasets/ercot_lmp_by_settlement_point/query',
  );
  assert.equal(url.searchParams.get('start_time'), '2026-11-09T13:42:00.000Z');
  assert.equal(url.searchParams.get('filter_column'), 'location');
  assert.equal(url.searchParams.get('filter_value'), 'HB_NORTH');
  assert.equal(url.searchParams.get('return_format'), 'json');
  // the key goes in a header, never in the URL
  assert.equal(url.searchParams.get('api_key'), null);
});

void test('the latest interval wins, whatever order the rows come in', () => {
  const live = parseLiveRows([
    row('2026-11-09T13:55:00Z', 44.1),
    row('2026-11-09T14:05:00Z', 45.0),
    row('2026-11-09T14:00:00Z', 44.4),
  ]);
  assert.deepEqual(live, {
    price: 45,
    previousPrice: 44.4,
    index: 44.5, // (44.1 + 44.4 + 45.0) / 3
    intervalStartUtc: '2026-11-09T14:05:00.000Z',
    intervalEndUtc: '2026-11-09T14:10:00.000Z',
  });
});

void test('a repeated interval keeps its last row, and string prices are read as numbers', () => {
  const live = parseLiveRows([
    row('2026-11-09T14:05:00Z', 45),
    row('2026-11-09T14:05:00Z', '46.25'),
  ]);
  assert.equal(live?.price, 46.25);
  assert.equal(live?.previousPrice, null);
  assert.equal(live?.index, null);
});

void test('a missed interval means no change figure and no index, as on chain', () => {
  const live = parseLiveRows([
    row('2026-11-09T13:50:00Z', 40),
    row('2026-11-09T13:55:00Z', 41),
    // 14:00 missing
    row('2026-11-09T14:05:00Z', 45),
  ]);
  assert.equal(live?.price, 45);
  assert.equal(live?.previousPrice, null);
  assert.equal(live?.index, null);
});

void test('negative prices pass through', () => {
  const live = parseLiveRows([
    row('2026-11-09T13:55:00Z', -2),
    row('2026-11-09T14:00:00Z', -3),
    row('2026-11-09T14:05:00Z', -4),
  ]);
  assert.equal(live?.index, -3);
  assert.equal(priceChange(live!), -1);
});

void test('malformed input gives null instead of a wrong price', () => {
  assert.equal(parseLiveRows(undefined), null);
  assert.equal(parseLiveRows({ data: [] }), null);
  assert.equal(parseLiveRows([]), null);
  assert.equal(
    parseLiveRows([
      { interval_start_utc: 'soon', interval_end_utc: 'later', lmp: 1 },
    ]),
    null,
  );
  assert.equal(parseLiveRows([row('2026-11-09T14:05:00Z', 'n/a')]), null);
  assert.equal(
    parseLiveRows([null, 7, row('2026-11-09T14:05:00Z', 45)])?.price,
    45,
  );
});

void test('a read is kept until the next interval is likely out, between 30 seconds and 5 minutes', () => {
  const end = '2026-11-09T14:10:00.000Z';
  // next interval ends 14:15, expected by 14:16
  assert.equal(cacheSeconds(end, Date.parse('2026-11-09T14:11:00Z')), 300);
  assert.equal(cacheSeconds(end, Date.parse('2026-11-09T14:14:30Z')), 90);
  assert.equal(cacheSeconds(end, Date.parse('2026-11-09T14:20:00Z')), 30);
  assert.equal(cacheSeconds(null, 0), 30);
});

void test('a price is delayed after 15 minutes', () => {
  const end = '2026-11-09T14:10:00.000Z';
  assert.equal(isStale(end, Date.parse('2026-11-09T14:25:00Z')), false);
  assert.equal(isStale(end, Date.parse('2026-11-09T14:25:01Z')), true);
});

void test('times show in Texas time', () => {
  assert.equal(texasClock('2026-11-09T20:05:00.000Z'), '14:05'); // CST, UTC-6
  assert.equal(texasClock('2026-07-09T19:05:00.000Z'), '14:05'); // CDT, UTC-5
});
