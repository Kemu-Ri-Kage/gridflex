import { formatToken, formatTokenExact } from './format.ts';
import { markE18, type MarkState } from './position.ts';
import { losingSide, redeemablePayout } from './redeemable.ts';

/**
 * The connected wallet's holdings across every listed market, for the
 * Portfolio tab and the winnings banner. Value is marked as the Positions
 * tab marks it (lib/position.ts): at the pool price while a market is
 * unsettled - indicative only, since there is no mUSDT exit before
 * settlement - and at what redeem() pays once it settles
 * (lib/redeemable.ts). Kept free of React for the node tests.
 */

const ONE = 10n ** 18n;

export interface Holding {
  yes: bigint;
  no: bigint;
}

export interface PortfolioMarket {
  address: string;
  /** Undefined until the market's state has been read. */
  live?: MarkState;
}

export interface PortfolioRow {
  address: string;
  /**
   * The chain balances, except that a resolved market's losing side counts
   * as 0: redeem() leaves it in the wallet, worth nothing.
   */
  yes: bigint;
  no: bigint;
  /** mUSDT base units; undefined until the market's state is read. */
  value?: bigint;
  /** 'indicative' at the pool price; 'payout' once resolved or cancelled. */
  basis?: 'indicative' | 'payout';
  /** What redeem() would pay now; 0 while unsettled. */
  redeemable: bigint;
}

export interface PortfolioTotals {
  /** Sum of the rows whose value is known. */
  value: bigint;
  /** Some of `value` is marked at a pool price. */
  indicative: boolean;
  redeemable: bigint;
  redeemableMarkets: number;
}

/**
 * One row per market the wallet holds YES or NO on, in `markets` order.
 * Markets it holds nothing on - or only a resolved market's losing side -
 * are left out, unless listed in `keep` (a redeem this session, so its
 * status stays on screen after the balance goes).
 */
export function portfolioRows(
  markets: readonly PortfolioMarket[],
  holdings: Readonly<Record<string, Holding>>,
  keep?: ReadonlySet<string>,
): PortfolioRow[] {
  const rows: PortfolioRow[] = [];
  for (const market of markets) {
    const holding = holdings[market.address];
    if (!holding) continue;
    const live = market.live;
    const lost = live ? losingSide(live) : undefined;
    const yes = lost === 'YES' ? 0n : holding.yes;
    const no = lost === 'NO' ? 0n : holding.no;
    if (yes === 0n && no === 0n && !keep?.has(market.address)) continue;

    const row: PortfolioRow = { address: market.address, yes, no, redeemable: 0n };
    if (live) {
      row.redeemable = redeemablePayout(live, holding.yes, holding.no);
      if (live.resolved || live.cancelled) {
        row.value = row.redeemable;
        row.basis = 'payout';
      } else {
        // Each side rounded down on its own, as the Positions tab shows it.
        row.value =
          (yes * markE18('YES', live)) / ONE + (no * markE18('NO', live)) / ONE;
        row.basis = 'indicative';
      }
    }
    rows.push(row);
  }
  return rows;
}

export function portfolioTotals(rows: readonly PortfolioRow[]): PortfolioTotals {
  const totals: PortfolioTotals = {
    value: 0n,
    indicative: false,
    redeemable: 0n,
    redeemableMarkets: 0,
  };
  for (const row of rows) {
    totals.value += row.value ?? 0n;
    if (row.basis === 'indicative') totals.indicative = true;
    totals.redeemable += row.redeemable;
    if (row.redeemable > 0n) totals.redeemableMarkets += 1;
  }
  return totals;
}

/** The markets redeem() would pay out on now, in row order. */
export function redeemableMarkets(rows: readonly PortfolioRow[]): string[] {
  return rows.filter((row) => row.redeemable > 0n).map((row) => row.address);
}

/** mUSDT to 2 decimals, or in full when that would round to "0". */
export function redeemAmount(amount: bigint): string {
  const rounded = formatToken(amount);
  return rounded === '0' ? formatTokenExact(amount) : rounded;
}

/** "You have 19.99 mUSDT to redeem on 1 market", or undefined when nothing is redeemable. */
export function winningsLine(totals: PortfolioTotals): string | undefined {
  if (totals.redeemable === 0n) return undefined;
  const count = totals.redeemableMarkets;
  return `You have ${redeemAmount(totals.redeemable)} mUSDT to redeem on ${count} ${count === 1 ? 'market' : 'markets'}`;
}

export type RedeemStatus = 'waiting' | 'redeeming' | 'redeemed' | 'failed';

/**
 * Redeem on each market in turn, one wallet prompt at a time. A failure -
 * a rejected prompt, a revert or a throw - is recorded against its market
 * and the next one still goes, so one bad market never silently drops the
 * rest.
 */
export async function redeemEach<A extends string>(
  addresses: readonly A[],
  redeemOne: (address: A) => Promise<boolean>,
  onStatus: (address: A, status: RedeemStatus) => void,
): Promise<{ redeemed: A[]; failed: A[] }> {
  const redeemed: A[] = [];
  const failed: A[] = [];
  for (const address of addresses) onStatus(address, 'waiting');
  for (const address of addresses) {
    onStatus(address, 'redeeming');
    let ok = false;
    try {
      ok = await redeemOne(address);
    } catch {
      ok = false;
    }
    (ok ? redeemed : failed).push(address);
    onStatus(address, ok ? 'redeemed' : 'failed');
  }
  return { redeemed, failed };
}

type OpenListener = () => void;

const openListeners = new Set<OpenListener>();

/** Ask the bottom panel to show the Portfolio tab (the winnings banner's link). */
export function openPortfolio(): void {
  for (const listener of openListeners) listener();
}

/** Called on every openPortfolio(); returns the unsubscribe. */
export function onOpenPortfolio(listener: OpenListener): () => void {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}
