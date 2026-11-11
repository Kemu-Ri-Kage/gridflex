/**
 * Builds the price file the market simulation replays: real ERCOT North Hub
 * 5-minute real-time prices (GridStatus ercot_lmp_by_settlement_point,
 * HB_NORTH, the same rows the price bot reads) for a run of Texas days.
 *
 *   node sim/build-price-fixture.ts <data/raw folder> [first Texas day, default 2026-09-15] [days, default 10]
 *
 * Writes sim/data/hb-north-5min-<first day>.json: the interval end of the
 * first price and one price ($/MWh) per 5 minutes after it. A missing
 * interval in the source is written as null (the simulation treats it as a
 * price GridStatus never had).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { texasDayStartMs } from '../lib/quote-bot.ts';

const [rawDir, firstDay = '2026-09-15', daysArg = '10'] = process.argv.slice(2);
if (!rawDir) throw new Error('usage: build-price-fixture.ts <data/raw> [day] [days]');
const days = Number(daysArg);
const dayKey = Number(firstDay.replaceAll('-', ''));
const startMs = texasDayStartMs(dayKey);
const endMs = startMs + days * 86_400_000;

const byEnd = new Map<number, number>();
for (const name of readdirSync(rawDir)) {
  if (!name.startsWith('ercot_lmp_by_settlement_point__HB_NORTH__')) continue;
  const rows = JSON.parse(readFileSync(join(rawDir, name), 'utf8')) as {
    interval_end_utc: string;
    lmp: number;
  }[];
  for (const row of rows) byEnd.set(Date.parse(row.interval_end_utc), row.lmp);
}

const lmp: (number | null)[] = [];
for (let end = startMs + 300_000; end <= endMs; end += 300_000)
  lmp.push(byEnd.get(end) ?? null);

const out = {
  dataset: 'ercot_lmp_by_settlement_point',
  location: 'HB_NORTH',
  note: 'Real ERCOT real-time 5-minute prices in $/MWh, one per interval, oldest first. Built by sim/build-price-fixture.ts from GridStatus files in data/raw.',
  firstTexasDay: firstDay,
  days,
  firstIntervalEndUtc: new Date(startMs + 300_000).toISOString(),
  intervalSeconds: 300,
  missing: lmp.filter((v) => v === null).length,
  lmp,
};
const path = `sim/data/hb-north-5min-${firstDay}.json`;
writeFileSync(path, `${JSON.stringify(out)}\n`);
console.log(`wrote ${path}: ${lmp.length} intervals, ${out.missing} missing`);
