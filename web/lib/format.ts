import { formatUnits } from 'viem';

export function formatToken(value: bigint): string {
  return Number(formatUnits(value, 6)).toLocaleString('en-US', {
    maximumFractionDigits: 2,
  });
}

/** Tailwind utility that keeps digit widths equal so numeric columns align. */
export const TABULAR_NUMS = 'tabular-nums';

/**
 * Dollar amount from integer cents, e.g. -1032 -> "-$10.32", 474 -> "$4.74".
 * `unit` appends a "/unit" suffix (e.g. "MWh"). `showPlus` shows "+" on a
 * positive value — only correct for a signed spread (e.g. the West-North
 * basis); a price level (e.g. North Hub, the load-weighted index) shows no
 * sign when positive, per shared/metrics.md's per-metric unit sections.
 */
export function formatPrice(cents: number, unit?: string, showPlus = false): string {
  const dollars = cents / 100;
  const sign = dollars < 0 ? '-' : dollars > 0 && showPlus ? '+' : '';
  const formatted = Math.abs(dollars).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${formatted}${unit ? `/${unit}` : ''}`;
}

/** Fraction (0-1) as a percentage string, e.g. 0.5 -> "50.0%". */
export function formatPercent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/**
 * Plain integer count with a unit label, e.g. formatCount(12, 'intervals')
 * -> "12 intervals". For metrics that are counts, not scaled currency —
 * per shared/metrics.md, ERCOT_HBWEST_NEG_INTERVALS is "plain integer
 * count, no scaling," unlike the three USD/MWh x100 metrics.
 */
export function formatCount(value: number, unit: string): string {
  return `${value} ${unit}`;
}

/**
 * The two clocks every "Updated" line shows: ERCOT's own (Texas) and UTC,
 * the one every reader can convert from. Texas's abbreviation comes from
 * en-US (CDT/CST); dates and times always use en-US fields so both halves
 * read the same way.
 */
const UPDATED_CLOCKS = [
  { label: 'Texas', timeZone: 'America/Chicago' },
  { label: 'UTC', timeZone: 'UTC' },
] as const;

function clockReading(date: Date, timeZone: string) {
  const fields = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const zone =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
  return {
    date: `${fields.day} ${fields.month} ${fields.year}`,
    time: `${fields.hour}:${fields.minute}`,
    zone,
  };
}

/**
 * When the data was last refreshed, in Texas time and UTC, e.g.
 * "22 Sep 2026, 06:03 CDT (Texas) · 11:03 UTC". The UTC date is repeated
 * only when it differs from the Texas one. Returns null for a missing or
 * unparseable timestamp, so callers show nothing rather than
 * "Invalid Date".
 */
export function formatUpdated(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const [texas, utc] = UPDATED_CLOCKS.map((clock) => clockReading(date, clock.timeZone));
  const utcText = utc.date === texas.date ? `${utc.time} UTC` : `${utc.date}, ${utc.time} UTC`;
  return `${texas.date}, ${texas.time} ${texas.zone} (Texas) · ${utcText}`;
}

/** A 1e18-scaled mUSDT price per token in cents, e.g. 0.50025e18 -> "50.0¢". */
export function formatCentsE18(priceE18: bigint): string {
  return `${(Number(priceE18) / 1e16).toFixed(1)}¢`;
}

/**
 * A price per token in whole cents, the terminal's headline quote, e.g.
 * 0.5234e18 -> "52¢". Near either end, where a whole cent would round a
 * live price to 0¢ or 100¢, it keeps one decimal: "0.4¢", "99.6¢".
 */
export function formatCentsShort(priceE18: bigint): string {
  const cents = Number(priceE18) / 1e16;
  if (cents > 0 && cents < 1) return `${cents.toFixed(1)}¢`;
  if (cents > 99 && cents < 100) return `${Math.min(99.9, cents).toFixed(1)}¢`;
  return `${Math.round(cents)}¢`;
}

/** A signed mUSDT amount with an explicit sign, e.g. "+1.99", "−0.42", "0.00". */
export function formatSignedToken(value: bigint): string {
  const direction = signedTokenDirection(value);
  const magnitude = formatToken(value < 0n ? -value : value);
  // Below the 0.01 display step a sign would claim a gain or loss that the
  // shown digits can't.
  if (direction === 'flat') return '0.00';
  return `${direction === 'down' ? '−' : '+'}${magnitude}`;
}

/**
 * Whether a signed token amount reads as a gain, a loss or neither once
 * shown at formatSignedToken's 0.01 step - so a P&L's colour always agrees
 * with its digits: "0.00" is flat, never up or down.
 */
export function signedTokenDirection(value: bigint): 'up' | 'down' | 'flat' {
  if (formatToken(value < 0n ? -value : value) === '0') return 'flat';
  return value < 0n ? 'down' : 'up';
}

/** A signed fraction as a percentage, e.g. 0.1994 -> "+19.9%"; "0.0%" when it rounds to zero. */
export function formatSignedPercent(fraction: number): string {
  const magnitude = Math.abs(fraction * 100).toFixed(1);
  if (magnitude === '0.0') return '0.0%';
  return `${fraction < 0 ? '−' : '+'}${magnitude}%`;
}

/** A 6-decimal token amount at full precision, e.g. 9995004n -> "9.995004". */
export function formatTokenExact(value: bigint): string {
  return Number(formatUnits(value, 6)).toLocaleString('en-US', {
    maximumFractionDigits: 6,
  });
}

/** A block's unix time in UTC, e.g. 1790116275 -> "22 Sep 2026, 22:31 UTC". */
export function formatBlockTime(seconds: number): string {
  const { date, time } = clockReading(new Date(seconds * 1000), 'UTC');
  return `${date}, ${time} UTC`;
}
