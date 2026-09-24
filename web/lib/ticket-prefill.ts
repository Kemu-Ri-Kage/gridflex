/**
 * Lets another panel load an order into the order ticket: the hedge
 * calculator's "Load in ticket" names a market, a side and an amount, and
 * the ticket fills them in once that market is selected. The last request
 * is held until the ticket for its market takes it, so it survives the
 * ticket re-rendering for the newly selected market. Nothing is ever sent
 * from here: the viewer still presses Buy. No React, so it is tested
 * directly.
 */

export interface TicketPrefill {
  /** The market's address, lower-cased or checksummed. */
  market: string;
  side: 'YES' | 'NO';
  /** mUSDT, as typed into the ticket's amount field. */
  amount: string;
}

type Listener = (prefill: TicketPrefill) => void;

let pending: TicketPrefill | undefined;
const listeners = new Set<Listener>();

/** Ask the ticket to show this order. Replaces any earlier request not yet taken. */
export function prefillTicket(prefill: TicketPrefill): void {
  pending = prefill;
  for (const listener of listeners) listener(prefill);
}

/** The pending request for `market`, removed so it's applied once; undefined for any other market. */
export function takeTicketPrefill(market: string | undefined): TicketPrefill | undefined {
  if (!pending || !market || pending.market.toLowerCase() !== market.toLowerCase()) return undefined;
  const taken = pending;
  pending = undefined;
  return taken;
}

/** Called with every new request; returns the unsubscribe. */
export function onTicketPrefill(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
