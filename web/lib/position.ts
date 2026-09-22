/**
 * A wallet's position on one market, rebuilt from that wallet's own market
 * events on chain (contracts/src/BinaryMarket.sol):
 *
 * - SetMinted(amount): `amount` mUSDT in, `amount` YES and `amount` NO out;
 * - Swapped(yesForNo, in, out): one side in, the other side out, no mUSDT;
 * - Redeemed(yesBurned, noBurned, payout): tokens burned after settlement.
 *
 * A Buy YES / Buy NO is a mint followed by a swap of exactly the minted
 * amount of the unwanted side, so a swap whose amountIn equals an open mint
 * of the same wallet is the second leg of a buy: `amount` mUSDT bought
 * `amount + out` of the side kept. Any other swap is a switch: it changes
 * side and carries the cost of the tokens given up to the tokens received.
 * Nothing here is a sale - the contract has no mUSDT exit before settlement.
 *
 * Kept free of imports so the node tests can load it.
 */

export type Side = 'YES' | 'NO';

export type PositionEvent =
  | { kind: 'mint'; amount: bigint }
  | { kind: 'swap'; yesForNo: boolean; amountIn: bigint; amountOut: bigint }
  | { kind: 'redeem'; yesBurned: bigint; noBurned: bigint }
  /** The balance changed in a block with none of this wallet's market events. */
  | { kind: 'transfer' };

interface SideLedger {
  quantity: bigint;
  /** mUSDT base units paid for `quantity`. */
  cost: bigint;
}

export type UndeterminedReason = 'pair' | 'transfer' | 'history';

export const UNDETERMINED_REASON: Record<UndeterminedReason, string> = {
  pair: "This wallet holds a YES + NO pair that was minted but never swapped, and a pair's cost can't be split between the two sides.",
  transfer:
    "Tokens moved in or out of this wallet outside this market's trades, so their cost isn't on chain.",
  history: "This wallet's trades couldn't be read from X Layer.",
};

export interface Ledger {
  YES: SideLedger;
  NO: SideLedger;
  /** Why an average entry can't be stated, if it can't. */
  undetermined?: UndeterminedReason;
}

const ONE = 10n ** 18n;

function otherSide(side: Side): Side {
  return side === 'YES' ? 'NO' : 'YES';
}

/** Move `quantity` out of a side, taking its proportional share of cost. */
function take(ledger: SideLedger, quantity: bigint): bigint {
  const cost =
    ledger.quantity === 0n ? 0n : (ledger.cost * quantity) / ledger.quantity;
  ledger.quantity -= quantity;
  ledger.cost -= cost;
  return cost;
}

/**
 * Whether each swap in a list of one wallet's events is the second leg of
 * a buy (true) or a switch (false), in event order. A swap matches the
 * earliest open mint of exactly its amountIn.
 */
export function swapIsBuyLeg(events: readonly PositionEvent[]): boolean[] {
  const openMints: bigint[] = [];
  const result: boolean[] = [];
  for (const event of events) {
    if (event.kind === 'mint') openMints.push(event.amount);
    if (event.kind !== 'swap') continue;
    const match = openMints.indexOf(event.amountIn);
    if (match >= 0) openMints.splice(match, 1);
    result.push(match >= 0);
  }
  return result;
}

/** Replay one wallet's events on one market, oldest first. */
export function buildLedger(events: readonly PositionEvent[]): Ledger {
  const ledger: Ledger = {
    YES: { quantity: 0n, cost: 0n },
    NO: { quantity: 0n, cost: 0n },
  };
  const buyLegs = swapIsBuyLeg(events);
  const openMints: bigint[] = [];
  let swapIndex = 0;

  for (const event of events) {
    switch (event.kind) {
      case 'mint':
        openMints.push(event.amount);
        break;
      case 'swap': {
        const from: Side = event.yesForNo ? 'YES' : 'NO';
        const to = otherSide(from);
        if (buyLegs[swapIndex++]) {
          openMints.splice(openMints.indexOf(event.amountIn), 1);
          ledger[to].quantity += event.amountIn + event.amountOut;
          ledger[to].cost += event.amountIn;
        } else if (ledger[from].quantity < event.amountIn) {
          // Switching tokens this ledger never saw arrive.
          ledger.undetermined ??= openMints.length > 0 ? 'pair' : 'transfer';
        } else {
          const carried = take(ledger[from], event.amountIn);
          ledger[to].quantity += event.amountOut;
          ledger[to].cost += carried;
        }
        break;
      }
      case 'redeem':
        take(ledger.YES, min(event.yesBurned, ledger.YES.quantity));
        take(ledger.NO, min(event.noBurned, ledger.NO.quantity));
        break;
      case 'transfer':
        ledger.undetermined ??= 'transfer';
        break;
    }
  }
  if (openMints.length > 0) ledger.undetermined ??= 'pair';
  return ledger;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export interface MarkState {
  /** BinaryMarket.price(): the pool's YES price, scaled by 1e18. */
  priceE18: bigint;
  resolved: boolean;
  cancelled: boolean;
  yesWon: boolean;
}

/**
 * What one token of `side` is marked at, scaled by 1e18: the pool price
 * while unsettled, the payout once settled (1 or 0, or 0.5 if cancelled).
 */
export function markE18(side: Side, state: MarkState): bigint {
  if (state.cancelled) return ONE / 2n;
  if (state.resolved) return (side === 'YES') === state.yesWon ? ONE : 0n;
  return side === 'YES' ? state.priceE18 : ONE - state.priceE18;
}

export interface PositionRow {
  side: Side;
  quantity: bigint;
  /** mUSDT per token, scaled by 1e18. Absent when it can't be determined. */
  averageEntryE18?: bigint;
  markE18: bigint;
  /** quantity x mark, in mUSDT base units. */
  value: bigint;
  cost?: bigint;
  /** value - cost, in mUSDT base units. */
  pnl?: bigint;
  /** pnl / cost as a fraction. */
  pnlFraction?: number;
  undetermined?: UndeterminedReason;
}

/**
 * One row per side the wallet holds. The chain balance is the quantity; the
 * ledger supplies the cost only when it accounts for exactly that balance.
 */
export function positionRows(
  balances: { YES: bigint; NO: bigint },
  state: MarkState,
  ledger: Ledger | { undetermined: UndeterminedReason },
): PositionRow[] {
  const rows: PositionRow[] = [];
  for (const side of ['YES', 'NO'] as const) {
    const quantity = balances[side];
    if (quantity === 0n) continue;
    const mark = markE18(side, state);
    const value = (quantity * mark) / ONE;
    const row: PositionRow = { side, quantity, markE18: mark, value };

    const sideLedger = 'YES' in ledger ? ledger[side] : undefined;
    if (ledger.undetermined || !sideLedger) {
      row.undetermined = ledger.undetermined ?? 'history';
    } else if (sideLedger.quantity !== quantity) {
      row.undetermined = 'transfer';
    } else {
      row.cost = sideLedger.cost;
      row.averageEntryE18 = (sideLedger.cost * ONE) / quantity;
      row.pnl = value - sideLedger.cost;
      row.pnlFraction =
        sideLedger.cost === 0n
          ? undefined
          : Number(row.pnl) / Number(sideLedger.cost);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * The blocks in (from, to] at which `probe` changes value, found by
 * bisection: a range whose two ends read the same is taken to hold no
 * change. `probe` returns a comparable key (e.g. "yesBalance:noBalance").
 * `fromValue` is the probe at `from`, if already known.
 */
export async function findChangeBlocks(
  probe: (block: bigint) => Promise<string>,
  from: bigint,
  to: bigint,
  fromValue?: string,
): Promise<bigint[]> {
  if (to <= from) return [];
  const [low, high] = await Promise.all([
    fromValue === undefined ? probe(from) : Promise.resolve(fromValue),
    probe(to),
  ]);
  const search = async (
    lo: bigint,
    hi: bigint,
    loValue: string,
    hiValue: string,
  ): Promise<bigint[]> => {
    if (loValue === hiValue) return [];
    if (hi - lo === 1n) return [hi];
    const mid = lo + (hi - lo) / 2n;
    const midValue = await probe(mid);
    const [left, right] = await Promise.all([
      search(lo, mid, loValue, midValue),
      search(mid, hi, midValue, hiValue),
    ]);
    return [...left, ...right];
  };
  return search(from, to, low, high);
}
