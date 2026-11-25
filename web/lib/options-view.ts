/**
 * The options screen's numbers, as TexasPowerOptions computes them: what a
 * buy escrows and pays at most, and which strikes to read. Contract units:
 * sizes in thousandths of a MWh, prices in cents per MWh, collateral in
 * 6-decimal units. No React here, so it is tested directly.
 */

import type { BandCents } from './perp-view.ts';

const UNITS_PER_CENT_SIZE = 10n;

/** The $5 strikes the screen reads quotes for: $5 to $120, inside the band. */
export function strikeGrid(
  band: BandCents,
  stepCents = 500,
  fromCents = 500,
  toCents = 12_000,
): number[] {
  const strikes: number[] = [];
  for (let s = fromCents; s <= toCents; s += stepCents) {
    if (s > band.floorCents && s < band.capCents) strikes.push(s);
  }
  return strikes;
}

export function maxPayoutCents(
  strikeCents: number,
  isCall: boolean,
  band: BandCents,
): number {
  return isCall ? band.capCents - strikeCents : strikeCents - band.floorCents;
}

export interface BuyPreview {
  /** Held now: size x the most you pay; the unused part comes back at the fill. */
  escrow: bigint;
  /** Cost at the current ask. */
  costAtAsk: bigint;
  /** The most the options can pay at settlement. */
  maxPayout: bigint;
  problem: string | null;
}

export function buyPreview(input: {
  size: bigint | null;
  askCents: number;
  limitCents: number | null;
  strikeCents: number;
  isCall: boolean;
  band: BandCents;
}): BuyPreview {
  const empty = { escrow: 0n, costAtAsk: 0n, maxPayout: 0n };
  if (input.size === null || input.size < 100n)
    return {
      ...empty,
      problem: 'Size is at least 0.1 MWh, in steps of 0.001.',
    };
  const max = maxPayoutCents(input.strikeCents, input.isCall, input.band);
  if (
    input.limitCents === null ||
    input.limitCents <= 0 ||
    input.limitCents > max
  ) {
    return {
      ...empty,
      problem: `The most you pay must be above $0 and at most $${(max / 100).toFixed(2)}.`,
    };
  }
  const value = (cents: number) =>
    input.size! * BigInt(cents) * UNITS_PER_CENT_SIZE;
  return {
    escrow: value(input.limitCents),
    costAtAsk: value(input.askCents),
    maxPayout: value(max),
    problem:
      input.askCents > input.limitCents
        ? 'The ask is above your limit: the order would cancel.'
        : null,
  };
}

/** A limit a little above the ask, so a small move between quotes still fills: ask + 5%, at least 1 cent more. */
export function defaultLimitCents(askCents: number, maxCents: number): number {
  return Math.min(maxCents, askCents + Math.max(1, Math.ceil(askCents * 0.05)));
}

/**
 * "Tue 10 Nov, 12:30" in Texas time, for an expiry's trading close. The close
 * is usually the day before the expiry day (the day-ahead auction), so the
 * date is always shown, never the time alone.
 */
export function closeLabel(closeUtc: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(closeUtc * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')}, ${get('hour')}:${get('minute')}`;
}

/** "Wed 11 Nov" for a dayKey. */
export function dayLabel(dayKey: number): string {
  const date = new Date(
    Date.UTC(
      Math.floor(dayKey / 10_000),
      Math.floor((dayKey % 10_000) / 100) - 1,
      dayKey % 100,
    ),
  );
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')}`;
}
