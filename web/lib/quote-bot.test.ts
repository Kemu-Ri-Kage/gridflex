import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildQuotes,
  runQuoteBot,
  texasDayKey,
  texasDayStartMs,
  texasLocalMs,
  upcomingExpiries,
  type QuoteVersion,
} from './quote-bot.ts';

const BAND = { floor: -50, cap: 300 };

void test('a Texas day starts at local midnight, 06:00 UTC in winter and 05:00 UTC in summer', () => {
  assert.equal(
    new Date(texasDayStartMs(20261112)).toISOString(),
    '2026-11-12T06:00:00.000Z',
  );
  assert.equal(
    new Date(texasDayStartMs(20260712)).toISOString(),
    '2026-07-12T05:00:00.000Z',
  );
  assert.equal(texasDayKey(Date.parse('2026-11-12T05:59:00Z')), 20261111);
  assert.equal(texasDayKey(Date.parse('2026-11-12T06:00:00Z')), 20261112);
});

void test('by default each day closes at 12:30 Texas time the day before, before the day-ahead auction', () => {
  const plans = upcomingExpiries(Date.parse('2026-11-09T17:45:00Z')); // 11:45 in Texas
  assert.deepEqual(
    plans.map((p) => p.dayKey),
    [20261110, 20261111, 20261112, 20261113, 20261114, 20261115, 20261116],
  );
  assert.equal(
    plans[0].tradingCloseUtc,
    Date.parse('2026-11-09T18:30:00Z') / 1000,
  );
  // after 12:30 in Texas, tomorrow has closed: it is no longer listed
  const later = upcomingExpiries(Date.parse('2026-11-09T18:25:00Z'));
  assert.equal(later[0].dayKey, 20261111);
});

void test('real-time-settled options may trade until the day starts', () => {
  const plans = upcomingExpiries(
    Date.parse('2026-11-09T18:25:00Z'),
    7,
    'dayStart',
  );
  assert.equal(plans[0].dayKey, 20261110);
  assert.equal(
    plans[0].tradingCloseUtc,
    Date.parse('2026-11-10T06:00:00Z') / 1000,
  );
});

void test('12:30 Texas time is found across a daylight-saving change', () => {
  // 8 Mar 2026: clocks go forward at 2am, so 12:30 is CDT (17:30 UTC)
  assert.equal(
    new Date(texasLocalMs(20260308, 12, 30)).toISOString(),
    '2026-03-08T17:30:00.000Z',
  );
  // 1 Nov 2026: clocks go back at 2am, so 12:30 is CST (18:30 UTC)
  assert.equal(
    new Date(texasLocalMs(20261101, 12, 30)).toISOString(),
    '2026-11-01T18:30:00.000Z',
  );
});

void test('daylight-saving changeover days are never listed', () => {
  // 1 Nov 2026 has 25 hours in Texas; 8 Mar 2026 has 23
  const autumn = upcomingExpiries(Date.parse('2026-10-28T12:00:00Z')).map(
    (p) => p.dayKey,
  );
  assert.ok(!autumn.includes(20261101));
  assert.ok(autumn.includes(20261102));
  const spring = upcomingExpiries(Date.parse('2026-03-05T12:00:00Z')).map(
    (p) => p.dayKey,
  );
  assert.ok(!spring.includes(20260308));
  assert.equal(spring.length, 6);
});

void test('quotes follow the day-ahead average once the auction is out', () => {
  const v = buildQuotes([30, 35, 40, 45, 50], 44.23, BAND)!;
  assert.equal(v.forward, 44.23);
  assert.deepEqual(
    v.strikesCents,
    [2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500],
  );
  assert.equal(v.quotes.length, 9);
  // cheaper calls and dearer puts as the strike rises
  for (let i = 1; i < v.quotes.length; i++) {
    assert.ok(v.quotes[i].callAsk <= v.quotes[i - 1].callAsk);
    assert.ok(v.quotes[i].putAsk >= v.quotes[i - 1].putAsk);
  }
  assert.equal(buildQuotes([40, 41], null, BAND), null);
});

void test('a run lists missing expiries and quotes each one; a dry run sends nothing', async () => {
  const listed = new Set([20261110]);
  const opened: number[] = [];
  const posted: Array<[number, QuoteVersion]> = [];
  const log: string[] = [];
  const deps = {
    band: BAND,
    isListed: async (dayKey: number) => listed.has(dayKey),
    openExpiry: async (plan: { dayKey: number }) => {
      opened.push(plan.dayKey);
      return '0xopen';
    },
    postQuotes: async (dayKey: number, version: QuoteVersion) => {
      posted.push([dayKey, version]);
      return '0xquote';
    },
    history: async () => [38, 41, 44, 47, 50, 43, 39],
    dayAhead: async (dayKey: number) => (dayKey === 20261110 ? 44.23 : null),
    log: (line: string) => log.push(line),
  };
  const now = Date.parse('2026-11-09T17:45:00Z');

  assert.equal(await runQuoteBot({ ...deps, dryRun: true }, now), 7);
  assert.equal(opened.length + posted.length, 0);
  assert.match(log.join('\n'), /dry run: would list 20261111/);

  assert.equal(await runQuoteBot({ ...deps, dryRun: false }, now), 7);
  assert.deepEqual(
    opened,
    [20261111, 20261112, 20261113, 20261114, 20261115, 20261116],
  );
  assert.equal(posted.length, 7);
  assert.equal(posted[0][1].forward, 44.23); // tomorrow: day-ahead known
  assert.equal(posted[1][1].forward.toFixed(2), '43.14'); // later days: the recent mean, 302 / 7
});
