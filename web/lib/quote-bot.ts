/**
 * The quote bot for TexasPowerOptions: lists the next market days as
 * expiries (trading until the Texas day starts) and posts call and put
 * quotes on nine $5 strikes around each day's expected price. Posting a
 * version also fills every pending order of that expiry, inside the
 * contract (GRIDFLEX Trading Platform Plan, "Market 2: options").
 *
 * Chain and data access are passed in (see bots/worker.ts), so the logic is
 * tested without a chain, a key or the network.
 */

import {
  forwardAndSigma,
  quoteStrike,
  strikesAround,
  type Band,
  type QuoteCents,
} from './option-pricing.ts';

const DAY_MS = 86_400_000;
const TEXAS = 'America/Chicago';

function chicagoParts(ms: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TEXAS,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
  };
}

/** The Texas calendar date of a moment, as a dayKey (YYYYMMDD). */
export function texasDayKey(ms: number): number {
  const { year, month, day } = chicagoParts(ms);
  return year * 10_000 + month * 100 + day;
}

/** The moment a Texas day starts (local midnight), in unix milliseconds. */
export function texasDayStartMs(dayKey: number): number {
  const year = Math.floor(dayKey / 10_000);
  const month = Math.floor((dayKey % 10_000) / 100);
  const day = dayKey % 100;
  // Texas midnight is 06:00 UTC in winter (CST) and 05:00 UTC in summer (CDT)
  let guess = Date.UTC(year, month - 1, day, 6);
  const hour = chicagoParts(guess).hour;
  if (hour !== 0) guess -= (hour > 12 ? hour - 24 : hour) * 3_600_000;
  return guess;
}

function addDays(dayKey: number, days: number): number {
  const year = Math.floor(dayKey / 10_000);
  const month = Math.floor((dayKey % 10_000) / 100);
  const d = new Date(Date.UTC(year, month - 1, dayKey % 100) + days * DAY_MS);
  return (
    d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
  );
}

export interface ExpiryPlan {
  dayKey: number;
  /** Unix seconds: trading stops when the Texas day starts. */
  tradingCloseUtc: number;
}

/**
 * The next `daysAhead` Texas days after today, as expiries. Daylight-saving
 * changeover days (23 or 25 hours) are skipped: they get no daily price
 * (shared/metrics.md), so they could never settle.
 */
export function upcomingExpiries(nowMs: number, daysAhead = 7): ExpiryPlan[] {
  const today = texasDayKey(nowMs);
  const plans: ExpiryPlan[] = [];
  for (let k = 1; k <= daysAhead; k++) {
    const dayKey = addDays(today, k);
    const start = texasDayStartMs(dayKey);
    if (texasDayStartMs(addDays(dayKey, 1)) - start !== DAY_MS) continue;
    plans.push({ dayKey, tradingCloseUtc: start / 1000 });
  }
  return plans;
}

export interface QuoteVersion {
  /** Strikes in cents per MWh, as the contract takes them. */
  strikesCents: number[];
  quotes: QuoteCents[];
  forward: number;
  sigma: number;
}

/**
 * Quotes for one expiry from past daily averages ($/MWh, oldest first) and
 * that day's day-ahead average when the auction is out. Null without enough
 * history to price anything.
 */
export function buildQuotes(
  history: readonly number[],
  dayAheadAverage: number | null,
  band: Band,
): QuoteVersion | null {
  const model = forwardAndSigma(history, dayAheadAverage);
  if (!model) return null;
  const strikes = strikesAround(model.forward, band);
  return {
    strikesCents: strikes.map((s) => Math.round(s * 100)),
    quotes: strikes.map((s) =>
      quoteStrike(model.forward, s, model.sigma, band),
    ),
    forward: model.forward,
    sigma: model.sigma,
  };
}

export interface QuoteBotDeps {
  band: Band;
  /** Whether the contract already lists the expiry. */
  isListed(dayKey: number): Promise<boolean>;
  openExpiry(plan: ExpiryPlan): Promise<string>;
  postQuotes(dayKey: number, version: QuoteVersion): Promise<string>;
  /** Past daily averages in $/MWh, oldest first. */
  history(): Promise<number[]>;
  /** The day-ahead average for a day once its auction is out, else null. */
  dayAhead(dayKey: number): Promise<number | null>;
  log(line: string): void;
  dryRun: boolean;
}

/** One run: list any missing expiries, then post a fresh quote version for each. */
export async function runQuoteBot(
  deps: QuoteBotDeps,
  nowMs: number,
): Promise<number> {
  const history = await deps.history();
  let posted = 0;
  for (const plan of upcomingExpiries(nowMs)) {
    if (!(await deps.isListed(plan.dayKey))) {
      if (deps.dryRun) deps.log(`dry run: would list ${plan.dayKey}`);
      else deps.log(`listed ${plan.dayKey} in ${await deps.openExpiry(plan)}`);
    }
    const version = buildQuotes(
      history,
      await deps.dayAhead(plan.dayKey),
      deps.band,
    );
    if (!version) {
      deps.log(`${plan.dayKey}: not enough price history to quote`);
      continue;
    }
    const label = `${plan.dayKey}: ${version.strikesCents.length} strikes around $${version.forward.toFixed(2)} (sigma $${version.sigma.toFixed(2)})`;
    if (deps.dryRun) {
      deps.log(`dry run: would quote ${label}`);
    } else {
      deps.log(
        `quoted ${label} in ${await deps.postQuotes(plan.dayKey, version)}`,
      );
    }
    posted++;
  }
  return posted;
}
