/**
 * The price bot: puts each finished 5-minute ERCOT North Hub price on chain
 * in LivePriceFeed (GRIDFLEX Trading Platform Plan, "The live Texas price").
 *
 * Every run reads the feed's latest interval, the last few prices from
 * GridStatus, and publishes the finished intervals the feed does not have
 * yet, oldest first and at most `maxRounds`, so after an outage the index
 * (three back-to-back rounds) comes back as fast as possible; older missed
 * intervals stay gaps, which the feed and the markets treat as "no price".
 *
 * Chain and data access are passed in (see bots/worker.ts), so the logic is
 * tested without a chain, a key or the network.
 */

import {
  INTERVAL_MS,
  LIVE_DATASET,
  LIVE_LOCATION,
  PUBLISH_LAG_MS,
} from './live-price.ts';

export interface FeedBounds {
  minPriceCents: number;
  maxPriceCents: number;
}

/** ERCOT's own limits: the -$251 floor and the $5,000 cap, as LivePriceFeed is deployed. */
export const ERCOT_BOUNDS: FeedBounds = {
  minPriceCents: -25_100,
  maxPriceCents: 500_000,
};

export interface Interval {
  startIso: string;
  /** Unix seconds, a multiple of 300. */
  end: number;
  lmp: number;
}

export interface Round {
  intervalEnd: number;
  priceCents: number;
  sourceHash: `0x${string}`;
  startIso: string;
  lmp: number;
}

/**
 * Finished 5-minute intervals from GridStatus rows, one per interval (a
 * repeated interval keeps its last row), sorted by end. Rows that are not
 * whole 5-minute intervals, or not over by `nowMs`, are left out.
 */
export function finishedIntervals(rows: unknown, nowMs: number): Interval[] {
  if (!Array.isArray(rows)) return [];
  const byEnd = new Map<number, Interval>();
  for (const value of rows) {
    if (typeof value !== 'object' || value === null) continue;
    const r = value as Record<string, unknown>;
    const lmp = typeof r.lmp === 'string' ? Number(r.lmp) : r.lmp;
    if (
      typeof r.interval_start_utc !== 'string' ||
      typeof r.interval_end_utc !== 'string'
    )
      continue;
    if (typeof lmp !== 'number' || !Number.isFinite(lmp)) continue;
    const start = Date.parse(r.interval_start_utc);
    const end = Date.parse(r.interval_end_utc);
    if (
      !Number.isFinite(start) ||
      end - start !== INTERVAL_MS ||
      end % INTERVAL_MS !== 0
    )
      continue;
    if (end > nowMs) continue;
    byEnd.set(end / 1000, {
      startIso: new Date(start).toISOString(),
      end: end / 1000,
      lmp,
    });
  }
  return [...byEnd.values()].toSorted((a, b) => a.end - b.end);
}

/**
 * The hash a round carries, which anyone can recompute from GridStatus:
 * SHA-256 of "ercot_lmp_by_settlement_point|HB_NORTH|<interval start, ISO>|<price in cents>".
 */
export async function sourceHash(
  startIso: string,
  priceCents: number,
): Promise<`0x${string}`> {
  const text = `${LIVE_DATASET}|${LIVE_LOCATION}|${startIso}|${priceCents}`;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return `0x${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export interface Plan {
  rounds: Round[];
  /** Intervals left out, and why: shown in the bot's log. */
  skipped: string[];
}

/** What to publish: finished intervals after the feed's latest, newest `maxRounds`, oldest first. */
export async function planRounds(
  intervals: readonly Interval[],
  latestOnChainEnd: number,
  bounds: FeedBounds = ERCOT_BOUNDS,
  maxRounds = 3,
): Promise<Plan> {
  const skipped: string[] = [];
  const fresh = intervals.filter((i) => i.end > latestOnChainEnd);
  const chosen = fresh.slice(-maxRounds);
  if (fresh.length > chosen.length) {
    skipped.push(
      `${fresh.length - chosen.length} older interval(s) left as a gap`,
    );
  }
  const rounds: Round[] = [];
  for (const interval of chosen) {
    const priceCents = Math.round(interval.lmp * 100);
    if (
      priceCents < bounds.minPriceCents ||
      priceCents > bounds.maxPriceCents
    ) {
      skipped.push(
        `${interval.startIso}: $${interval.lmp} is outside the feed's bounds`,
      );
      continue;
    }
    rounds.push({
      intervalEnd: interval.end,
      priceCents,
      sourceHash: await sourceHash(interval.startIso, priceCents),
      startIso: interval.startIso,
      lmp: interval.lmp,
    });
  }
  return { rounds, skipped };
}

export interface PriceBotDeps {
  /** The feed's latest round's intervalEnd in unix seconds, 0 when it has none. */
  latestEnd(): Promise<number>;
  /** GridStatus rows for the last few intervals. */
  fetchRows(nowMs: number): Promise<unknown>;
  /** Sends submitPrice and waits for it; returns the transaction hash. */
  submit(round: Round): Promise<string>;
  log(line: string): void;
  /** When true, nothing is sent: the run only logs what it would publish. */
  dryRun: boolean;
}

/** One run of the bot. Returns the rounds it published (or would have, in a dry run). */
export async function runPriceBot(
  deps: PriceBotDeps,
  nowMs: number,
): Promise<Round[]> {
  const latest = await deps.latestEnd();
  // The bot runs every minute but asks GridStatus only once the next interval
  // is likely out: about 288 reads a day instead of 1,440.
  if (latest && nowMs < latest * 1000 + INTERVAL_MS + PUBLISH_LAG_MS) {
    deps.log(
      `waiting: the interval after ${new Date(latest * 1000).toISOString()} is not out yet`,
    );
    return [];
  }
  const intervals = finishedIntervals(await deps.fetchRows(nowMs), nowMs);
  const { rounds, skipped } = await planRounds(intervals, latest);
  for (const line of skipped) deps.log(`skip: ${line}`);
  if (rounds.length === 0) {
    deps.log(
      `nothing new after ${latest ? new Date(latest * 1000).toISOString() : 'the start'}`,
    );
    return [];
  }
  for (const round of rounds) {
    const label = `${round.startIso} $${(round.priceCents / 100).toFixed(2)}`;
    if (deps.dryRun) {
      deps.log(`dry run: would publish ${label}`);
      continue;
    }
    // one at a time and in order: the feed refuses an interval that is not after the latest
    const hash = await deps.submit(round);
    deps.log(`published ${label} in ${hash}`);
  }
  return rounds;
}
