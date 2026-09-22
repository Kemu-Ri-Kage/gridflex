/**
 * The recovery record for a Buy YES / Buy NO order that stopped half-way.
 *
 * A buy is two transactions: mintSet() locks mUSDT for a YES + NO pair, then
 * swap() trades the unwanted side into the wanted one. If the second step
 * fails, the wallet holds both sides and the order is unfinished. This
 * record keeps that fact across market switches and page reloads, so the
 * ticket can block every new order until the user finishes it or chooses to
 * keep both sides.
 *
 * Stored in localStorage per chain and wallet. It holds no secrets: the
 * market address, the side, the minted amount and when it was minted.
 */

export type PendingSide = 'YES' | 'NO';

export interface PendingOrder {
  /** The market the pair was minted on. */
  market: string;
  /** The side the user asked for. */
  side: PendingSide;
  /** Minted amount in token base units (6 decimals), as a decimal string. */
  amount: string;
  /** Unix milliseconds when the mint confirmed. */
  createdAt: number;
}

export type PendingOrderStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UNITS = /^[1-9]\d*$/;

export function pendingOrderKey(chainId: number, account: string): string {
  return `gridflex:pending-order:${chainId}:${account.toLowerCase()}`;
}

function parsePendingOrder(raw: string | null): PendingOrder | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<PendingOrder>;
    if (
      typeof value.market === 'string' &&
      ADDRESS.test(value.market) &&
      (value.side === 'YES' || value.side === 'NO') &&
      typeof value.amount === 'string' &&
      UNITS.test(value.amount) &&
      typeof value.createdAt === 'number' &&
      Number.isFinite(value.createdAt)
    ) {
      return {
        market: value.market,
        side: value.side,
        amount: value.amount,
        createdAt: value.createdAt,
      };
    }
  } catch {
    // Malformed JSON reads as no record.
  }
  return undefined;
}

/** The unfinished order for this chain and wallet, if any. Never throws. */
export function loadPendingOrder(
  storage: PendingOrderStorage | undefined,
  chainId: number,
  account: string,
): PendingOrder | undefined {
  try {
    return parsePendingOrder(
      storage?.getItem(pendingOrderKey(chainId, account)) ?? null,
    );
  } catch {
    return undefined;
  }
}

/**
 * Record an unfinished order. Refuses to overwrite a different record that
 * is already there, so one unfinished order can never replace another.
 * Returns whether the record is now stored.
 */
export function savePendingOrder(
  storage: PendingOrderStorage | undefined,
  chainId: number,
  account: string,
  order: PendingOrder,
): boolean {
  if (!storage) return false;
  const existing = loadPendingOrder(storage, chainId, account);
  if (existing && !samePendingOrder(existing, order)) return false;
  try {
    storage.setItem(
      pendingOrderKey(chainId, account),
      JSON.stringify({
        market: order.market,
        side: order.side,
        amount: order.amount,
        createdAt: order.createdAt,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the record. Called only when the swap confirms or the user chooses
 * to keep both sides.
 */
export function clearPendingOrder(
  storage: PendingOrderStorage | undefined,
  chainId: number,
  account: string,
): void {
  try {
    storage?.removeItem(pendingOrderKey(chainId, account));
  } catch {
    // Storage unavailable: nothing to clear.
  }
}

/** The minted amount in token base units. */
export function pendingOrderUnits(order: PendingOrder): bigint {
  return BigInt(order.amount);
}

export function samePendingOrder(a: PendingOrder, b: PendingOrder): boolean {
  return (
    a.market.toLowerCase() === b.market.toLowerCase() &&
    a.side === b.side &&
    a.amount === b.amount &&
    a.createdAt === b.createdAt
  );
}

export interface OrderGate {
  /** A new order may not start, on any market. */
  blocked: boolean;
  /** The unfinished order belongs to a market other than the selected one. */
  elsewhere: boolean;
}

export function orderGate(
  pending: PendingOrder | undefined,
  selectedMarket: string | undefined,
): OrderGate {
  if (!pending) return { blocked: false, elsewhere: false };
  return {
    blocked: true,
    elsewhere:
      pending.market.toLowerCase() !== (selectedMarket ?? '').toLowerCase(),
  };
}
