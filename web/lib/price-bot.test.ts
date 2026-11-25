import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  finishedIntervals,
  planRounds,
  runPriceBot,
  sourceHash,
  type Round,
} from './price-bot.ts';

const row = (start: string, lmp: number | string) => ({
  interval_start_utc: start,
  interval_end_utc: new Date(Date.parse(start) + 300_000).toISOString(),
  lmp,
});
const NOW = Date.parse('2026-11-09T14:11:00Z');
const at = (iso: string) => Date.parse(iso) / 1000;

void test('only whole, finished 5-minute intervals count, one per interval', () => {
  const intervals = finishedIntervals(
    [
      row('2026-11-09T14:00:00Z', 44.4),
      row('2026-11-09T13:55:00Z', 44.1),
      row('2026-11-09T14:00:00Z', 44.6), // re-dispatched: the last row wins
      row('2026-11-09T14:10:00Z', 45), // still running at 14:11
      {
        interval_start_utc: '2026-11-09T14:02:00Z',
        interval_end_utc: '2026-11-09T14:07:00Z',
        lmp: 1,
      },
      {
        interval_start_utc: '2026-11-09T14:05:00Z',
        interval_end_utc: '2026-11-09T14:10:00Z',
        lmp: 'n/a',
      },
    ],
    NOW,
  );
  assert.deepEqual(
    intervals.map((i) => [i.end, i.lmp]),
    [
      [at('2026-11-09T14:00:00Z'), 44.1],
      [at('2026-11-09T14:05:00Z'), 44.6],
    ],
  );
  assert.deepEqual(finishedIntervals({ data: [] }, NOW), []);
});

void test('the source hash is SHA-256 of the dataset, hub, interval start and price, so anyone can recompute it', async () => {
  const expected = createHash('sha256')
    .update(
      'ercot_lmp_by_settlement_point|HB_NORTH|2026-11-09T14:05:00.000Z|4971',
    )
    .digest('hex');
  assert.equal(
    await sourceHash('2026-11-09T14:05:00.000Z', 4971),
    `0x${expected}`,
  );
});

void test('the bot publishes what the feed lacks, oldest first, prices in whole cents', async () => {
  const intervals = finishedIntervals(
    [
      row('2026-11-09T13:50:00Z', 40),
      row('2026-11-09T13:55:00Z', 49.71),
      row('2026-11-09T14:00:00Z', -3.2),
    ],
    NOW,
  );
  const { rounds, skipped } = await planRounds(
    intervals,
    at('2026-11-09T13:55:00Z'),
  );
  assert.deepEqual(
    rounds.map((r) => [r.intervalEnd, r.priceCents]),
    [
      [at('2026-11-09T14:00:00Z'), 4971], // 49.71 x 100 is 4970.999..., rounded
      [at('2026-11-09T14:05:00Z'), -320],
    ],
  );
  assert.deepEqual(skipped, []);
});

void test('after an outage only the newest three go out, so the index returns at once', async () => {
  const rows = [0, 5, 10, 15, 20, 25].map((m) =>
    row(
      new Date(Date.parse('2026-11-09T13:35:00Z') + m * 60_000).toISOString(),
      40 + m,
    ),
  );
  const { rounds, skipped } = await planRounds(finishedIntervals(rows, NOW), 0);
  assert.deepEqual(
    rounds.map((r) => r.priceCents),
    [5500, 6000, 6500],
  );
  assert.deepEqual(skipped, ['3 older interval(s) left as a gap']);
});

void test('a price outside the feed bounds is left out, not clamped', async () => {
  const { rounds, skipped } = await planRounds(
    finishedIntervals([row('2026-11-09T14:00:00Z', 6000)], NOW),
    0,
  );
  assert.deepEqual(rounds, []);
  assert.equal(skipped.length, 1);
});

void test('a dry run logs and sends nothing; a live run sends each round in order', async () => {
  const sent: Round[] = [];
  const log: string[] = [];
  const deps = {
    latestEnd: async () => at('2026-11-09T14:00:00Z'),
    fetchRows: async () => [
      row('2026-11-09T13:55:00Z', 44),
      row('2026-11-09T14:00:00Z', 45),
      row('2026-11-09T14:05:00Z', 46),
    ],
    submit: async (r: Round) => {
      sent.push(r);
      return `0xtx${sent.length}`;
    },
    log: (line: string) => log.push(line),
  };

  const dry = await runPriceBot({ ...deps, dryRun: true }, NOW);
  assert.equal(dry.length, 2);
  assert.equal(sent.length, 0);
  assert.match(
    log.join('\n'),
    /dry run: would publish 2026-11-09T14:00:00.000Z \$45.00/,
  );

  await runPriceBot({ ...deps, dryRun: false }, NOW);
  assert.deepEqual(
    sent.map((r) => r.priceCents),
    [4500, 4600],
  );
  assert.match(
    log.at(-1)!,
    /published 2026-11-09T14:05:00.000Z \$46.00 in 0xtx2/,
  );
});

void test('nothing new means nothing sent', async () => {
  const log: string[] = [];
  const rounds = await runPriceBot(
    {
      latestEnd: async () => at('2026-11-09T14:10:00Z'),
      fetchRows: async () => [row('2026-11-09T14:05:00Z', 46)],
      submit: async () => assert.fail('must not send'),
      log: (line) => log.push(line),
      dryRun: false,
    },
    Date.parse('2026-11-09T14:16:30Z'), // the 14:15 interval is due, but GridStatus lacks it
  );
  assert.deepEqual(rounds, []);
  assert.match(log[0], /nothing new/);
});

void test('between intervals the bot does not ask GridStatus at all', async () => {
  let fetched = 0;
  const deps = {
    latestEnd: async () => at('2026-11-09T14:10:00Z'),
    fetchRows: async () => {
      fetched++;
      return [];
    },
    submit: async () => assert.fail('must not send'),
    log: () => {},
    dryRun: false,
  };
  // the 14:15 interval is expected by about 14:16
  await runPriceBot(deps, Date.parse('2026-11-09T14:15:30Z'));
  assert.equal(fetched, 0);
  await runPriceBot(deps, Date.parse('2026-11-09T14:16:00Z'));
  assert.equal(fetched, 1);
});
