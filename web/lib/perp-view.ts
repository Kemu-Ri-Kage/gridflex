/**
 * The futures screen's numbers, exactly as TexasPowerPerp computes them, so
 * the ticket shows what the contract will take before the wallet asks.
 *
 * Contract units: sizes in thousandths of a MWh (1,000 = 1 MWh), prices in
 * cents per MWh, collateral in 6-decimal units (1 cent on 1 size unit is 10
 * units). No React here, so it is tested directly.
 */

export const SIZE_PER_MWH = 1000;
export const MIN_SIZE = 100;
const UNITS_PER_CENT_SIZE = 10n;
const BPS = 10_000n;

export interface BandCents {
  floorCents: number;
  capCents: number;
}

export type Side = 'long' | 'short';

/** Size units for a MWh amount typed by the user, or null if it is not a whole number of units. */
export function sizeUnits(mwh: string): bigint | null {
  if (!/^\d+(\.\d{1,3})?$/.test(mwh.trim())) return null;
  const [whole, frac = ''] = mwh.trim().split('.');
  const units = BigInt(whole) * 1000n + BigInt(frac.padEnd(3, '0'));
  return units;
}

/** Whole cents for a dollar price typed by the user, or null. */
export function priceCents(dollars: string): number | null {
  if (!/^-?\d+(\.\d{1,2})?$/.test(dollars.trim())) return null;
  return Math.round(Number(dollars) * 100);
}

function value(size: bigint, cents: number): bigint {
  return size * BigInt(cents) * UNITS_PER_CENT_SIZE;
}

function fee(size: bigint, cents: number, feeBps: number): bigint {
  return (value(size, Math.abs(cents)) * BigInt(feeBps)) / BPS;
}

export interface TicketPreview {
  /** What the order escrows now: the worst collateral plus the largest fee; the rest comes back at the fill. */
  escrow: bigint;
  /** Collateral, largest gain and open fee if the fill came at `indexCents`. */
  collateralAtIndex: bigint;
  maxGainAtIndex: bigint;
  feeAtIndex: bigint;
  /** What the pool must have free to accept the order (the widest move). */
  poolNeeded: bigint;
  /** Why the order would be refused, or null. */
  problem: string | null;
}

/** The ticket for an order, checked like requestOpen checks it. */
export function perpTicket(input: {
  side: Side;
  size: bigint | null;
  limitCents: number | null;
  indexCents: number | null;
  band: BandCents;
  feeBps: number;
  freePool: bigint;
}): TicketPreview {
  const { side, size, limitCents, band, feeBps } = input;
  const empty = {
    escrow: 0n,
    collateralAtIndex: 0n,
    maxGainAtIndex: 0n,
    feeAtIndex: 0n,
    poolNeeded: 0n,
  };
  if (size === null || size < BigInt(MIN_SIZE))
    return {
      ...empty,
      problem: 'Size is at least 0.1 MWh, in steps of 0.001.',
    };
  if (limitCents === null)
    return { ...empty, problem: 'Enter a limit price in dollars.' };
  if (limitCents <= band.floorCents || limitCents >= band.capCents) {
    return {
      ...empty,
      problem: `The limit must be inside $${band.floorCents / 100} to $${band.capCents / 100}.`,
    };
  }
  const widest = Math.max(band.capCents, -band.floorCents);
  const worstMove =
    side === 'long' ? limitCents - band.floorCents : band.capCents - limitCents;
  const escrow = value(size, worstMove) + fee(size, widest, feeBps);
  const poolNeeded = value(size, band.capCents - band.floorCents);
  const index =
    input.indexCents === null
      ? limitCents
      : Math.min(Math.max(input.indexCents, band.floorCents), band.capCents);
  const collateralAtIndex = value(
    size,
    side === 'long' ? index - band.floorCents : band.capCents - index,
  );
  const maxGainAtIndex = value(
    size,
    side === 'long' ? band.capCents - index : index - band.floorCents,
  );
  const problem =
    poolNeeded > input.freePool
      ? 'The pool cannot cover an order this large right now.'
      : null;
  return {
    escrow,
    collateralAtIndex,
    maxGainAtIndex,
    feeAtIndex: fee(size, index, feeBps),
    poolNeeded,
    problem,
  };
}

export interface OpenPosition {
  isLong: boolean;
  entryPriceCents: number;
  size: bigint;
  collateral: bigint;
  reserve: bigint;
}

/** A position's gain or loss at a price (clamped to the band) and what closing there would pay before funding. */
export function positionAt(
  position: OpenPosition,
  indexCents: number,
  band: BandCents,
  feeBps: number,
) {
  const price = Math.min(Math.max(indexCents, band.floorCents), band.capCents);
  const move = position.isLong
    ? price - position.entryPriceCents
    : position.entryPriceCents - price;
  const pnl = position.size * BigInt(move) * UNITS_PER_CENT_SIZE;
  const closeFee = fee(position.size, price, feeBps);
  const equity = position.collateral + pnl - closeFee;
  return { pnl, closeFee, payout: equity > 0n ? equity : 0n };
}

/** 6-decimal units as dollars, e.g. 943300000n -> "$943.30". */
export function dollars(units: bigint): string {
  const negative = units < 0n;
  const cents = (negative ? -units : units) / 10_000n;
  const whole = cents / 100n;
  const rest = (cents % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}$${whole.toLocaleString('en-US')}.${rest}`;
}

/** Size units as MWh, e.g. 10500n -> "10.5 MWh". */
export function mwhLabel(size: bigint): string {
  const whole = size / 1000n;
  const frac = (size % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} MWh`;
}
