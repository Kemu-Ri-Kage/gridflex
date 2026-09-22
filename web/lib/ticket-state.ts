/**
 * What the order ticket may do for a market at a given moment, derived
 * from the contract's own rules (contracts/src/BinaryMarket.sol):
 *
 * - mintSet() and swap() revert with TradingClosed once
 *   block.timestamp >= resolveAfter, so resolveAfter is the trading cut-off;
 * - resolve() is allowed from that same instant, given a final reading;
 * - cancel() is allowed from resolveAfter + disputeWindow, given no reading;
 * - redeem() needs the market to be resolved or cancelled.
 */
export interface TicketSnapshot {
  address?: string;
  loaded: boolean;
  resolved: boolean;
  cancelled: boolean;
  resolveAfter: number;
  disputeWindow: number;
}

export interface TicketState {
  /** The snapshot describes the selected market and has been read. */
  ready: boolean;
  settled: boolean;
  /** Trading has closed (resolve() may be called). */
  closed: boolean;
  /** The grace period has passed (cancel() may be called). */
  cancellable: boolean;
  /** Buy YES / Buy NO are allowed. */
  tradingOpen: boolean;
}

export function ticketState(
  snapshot: TicketSnapshot,
  market: string | undefined,
  nowSeconds: number,
): TicketState {
  const ready =
    Boolean(market) &&
    snapshot.loaded &&
    (snapshot.address ?? '').toLowerCase() === (market ?? '').toLowerCase();
  const settled = ready && (snapshot.resolved || snapshot.cancelled);
  const closed = ready && nowSeconds >= snapshot.resolveAfter;
  const cancellable =
    ready && nowSeconds >= snapshot.resolveAfter + snapshot.disputeWindow;
  return {
    ready,
    settled,
    closed,
    cancellable,
    tradingOpen: ready && !closed && !settled,
  };
}
