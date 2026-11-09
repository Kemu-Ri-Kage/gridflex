/**
 * The live Texas power price: the latest 5-minute ERCOT North Hub real-time
 * price (SCED dispatch LMP, the dataset the 15m and 1H candles already use),
 * read from GridStatus by /api/v1/live-price and shown by the live strip on
 * /trade. GRIDFLEX Trading Platform Plan, "The live Texas price".
 *
 * No React and no Worker APIs here, so it is tested directly.
 */

export const LIVE_DATASET = 'ercot_lmp_by_settlement_point';
export const LIVE_LOCATION = 'HB_NORTH';
export const GRIDSTATUS_HOST = 'https://api.gridstatus.io/v1';

/** One interval: 5 minutes. */
export const INTERVAL_MS = 300_000;
/** ERCOT's dispatch runs a few seconds after each interval ends; GridStatus has it within a minute. */
export const PUBLISH_LAG_MS = 60_000;
/** How far back a read looks: enough for the three intervals the index averages, plus slack. */
export const LOOKBACK_MS = 25 * 60_000;
/** A price older than this is shown as delayed. */
export const STALE_AFTER_MS = 15 * 60_000;

export interface LivePrice {
  /** Dollars per MWh. */
  price: number;
  /** The interval before, or null if it is missing. */
  previousPrice: number | null;
  /**
   * The GRIDFLEX Texas Live Index: the average of the last three back-to-back
   * 5-minute prices, as LivePriceFeed computes it on chain; null across a gap.
   */
  index: number | null;
  intervalStartUtc: string;
  intervalEndUtc: string;
}

export interface LivePriceResponse {
  configured: boolean;
  live: LivePrice | null;
  fetchedAt: string;
}

/** The GridStatus query for the last LOOKBACK_MS of North Hub 5-minute prices. */
export function liveQueryUrl(nowMs: number, host = GRIDSTATUS_HOST): string {
  const params = new URLSearchParams({
    start_time: new Date(nowMs - LOOKBACK_MS).toISOString(),
    filter_column: 'location',
    filter_value: LIVE_LOCATION,
    filter_operator: '=',
    columns: 'interval_start_utc,interval_end_utc,lmp',
    return_format: 'json',
    limit: '20',
  });
  return `${host}/datasets/${LIVE_DATASET}/query?${params.toString()}`;
}

interface Row {
  start: number;
  startIso: string;
  endIso: string;
  lmp: number;
}

function toRow(value: unknown): Row | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const startIso = r.interval_start_utc;
  const endIso = r.interval_end_utc;
  const lmp = typeof r.lmp === 'string' ? Number(r.lmp) : r.lmp;
  if (
    typeof startIso !== 'string' ||
    typeof endIso !== 'string' ||
    typeof lmp !== 'number'
  )
    return null;
  const start = Date.parse(startIso);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(Date.parse(endIso)) ||
    !Number.isFinite(lmp)
  )
    return null;
  return {
    start,
    startIso: new Date(start).toISOString(),
    endIso: new Date(Date.parse(endIso)).toISOString(),
    lmp,
  };
}

/**
 * The latest price from GridStatus rows, in any order and possibly repeated
 * (a re-dispatched interval keeps its last row). Malformed rows are skipped;
 * no usable row gives null.
 */
export function parseLiveRows(rows: unknown): LivePrice | null {
  if (!Array.isArray(rows)) return null;
  const byStart = new Map<number, Row>();
  for (const value of rows) {
    const row = toRow(value);
    if (row) byStart.set(row.start, row);
  }
  const sorted = [...byStart.values()].toSorted((a, b) => a.start - b.start);
  const last = sorted.at(-1);
  if (!last) return null;
  const before = sorted.at(-2);
  const previousPrice =
    before && last.start - before.start === INTERVAL_MS ? before.lmp : null;
  return {
    price: last.lmp,
    previousPrice,
    index: liveIndex(sorted),
    intervalStartUtc: last.startIso,
    intervalEndUtc: last.endIso,
  };
}

/** The average of the last three prices if they are back to back, else null. */
function liveIndex(sorted: readonly Row[]): number | null {
  const three = sorted.slice(-3);
  if (three.length < 3) return null;
  for (let i = 1; i < three.length; i++) {
    if (three[i].start - three[i - 1].start !== INTERVAL_MS) return null;
  }
  return (
    Math.round((three.reduce((sum, row) => sum + row.lmp, 0) / 3) * 100) / 100
  );
}

/**
 * Seconds to keep a read: until the next interval is likely published,
 * between 30 seconds and 5 minutes. One GridStatus request per new interval
 * per Worker isolate, about 288 a day.
 */
export function cacheSeconds(
  intervalEndUtc: string | null,
  nowMs: number,
): number {
  if (!intervalEndUtc) return 30;
  const nextExpected =
    Date.parse(intervalEndUtc) + INTERVAL_MS + PUBLISH_LAG_MS;
  const seconds = Math.ceil((nextExpected - nowMs) / 1000);
  return Math.min(300, Math.max(30, seconds));
}

export function isStale(intervalEndUtc: string, nowMs: number): boolean {
  return nowMs - Date.parse(intervalEndUtc) > STALE_AFTER_MS;
}

/** "14:05" in Texas (Central) time. */
export function texasClock(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

/** The change from the interval before, in dollars, or null without one. */
export function priceChange(live: LivePrice): number | null {
  if (live.previousPrice === null) return null;
  return Math.round((live.price - live.previousPrice) * 100) / 100;
}
