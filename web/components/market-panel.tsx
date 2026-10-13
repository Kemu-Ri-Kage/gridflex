'use client';

import * as React from 'react';
import type { Address } from 'viem';

import { PRESSABLE, Ticker } from '@/components/terminal-ui';
import { closesIn } from '@/lib/closes-in';
import { formatDollarsShort } from '@/lib/format';
import { byTerm, TERM_LABELS, TERMS, termOf, type Term } from '@/lib/market-term';
import {
  contractLabel,
  expiryLabel,
  marketStatus,
  shownYesPriceE18,
  strikeLabel,
  useMarkets,
  type Market,
  type MarketStatus,
} from '@/lib/markets';
import { cn } from '@/lib/utils';

const ONE_E18 = 10n ** 18n;

/** The chain's columns: strike, then Long and Short at a price's width each. */
const CHAIN_ROW = 'grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-baseline gap-x-2';

/**
 * One chain cell: a side's price while the market trades, what it paid
 * once settled (the paying side bright, the other dimmed), a dash while
 * there is no price that means anything (closed, waiting for its reading).
 */
function ChainPrice({
  market,
  status,
  side,
}: {
  market: Market;
  status: MarketStatus | undefined;
  side: 'YES' | 'NO';
}) {
  const live = market.live;
  const tone = side === 'YES' ? 'text-up' : 'text-down';
  const settled = status === 'resolved' || status === 'cancelled';
  if (!live || !(status === 'trading' || settled)) {
    return <span className="text-right font-mono text-[13px] text-muted-foreground">—</span>;
  }
  const yes = shownYesPriceE18(live);
  const price = side === 'YES' ? yes : ONE_E18 - yes;
  if (settled) {
    const paid = price > 0n;
    return (
      <span className={cn('text-right font-mono text-[13px]', paid ? tone : 'text-muted-foreground')}>
        {formatDollarsShort(price)}
      </span>
    );
  }
  return (
    <Ticker
      className={cn('text-right font-mono text-[13px]', tone)}
      numeric={Number(price)}
      value={formatDollarsShort(price)}
    />
  );
}

/** Consecutive markets with the same expiry day, as the chain lists them. */
function byExpiry(markets: Market[]): { dayKey: number; markets: Market[] }[] {
  const expiries: { dayKey: number; markets: Market[] }[] = [];
  for (const market of markets) {
    const last = expiries.at(-1);
    if (last && last.dayKey === market.dayKey) last.markets.push(market);
    else expiries.push({ dayKey: market.dayKey, markets: [market] });
  }
  return expiries;
}

/**
 * The listed contracts on the Texas power price as an options chain, each
 * named and priced from its own contract state - never a hand-typed list
 * (design-brief.md §5, §6, §8). Grouped by maturity (lib/market-term.ts):
 * next day, this week, later, then the ones waiting for their price and
 * the settled ones; within a group, by expiry day, then one row per strike,
 * highest first, with the Long and Short price per contract (what each
 * paid, once settled). The same digital contract at every maturity; a
 * next-day contract settles the next afternoon.
 *
 * Below lg the list collapses to one compact dropdown directly under the
 * instrument bar, so the chart follows it on a phone (§10). The dropdown
 * is the same height loading or loaded, so nothing below it shifts. At lg
 * the list scrolls inside its column, so a long ladder never stretches the
 * terminal's row and the chart with it.
 */
export function MarketPanel() {
  const { markets, selected, select, error, now } = useMarkets();
  const listed = markets && markets.length > 0 ? markets : null;
  const emptyText = error ?? (markets ? 'No contracts listed yet.' : 'Loading…');

  const groups = React.useMemo(() => {
    if (!listed) return null;
    const ordered = byTerm(
      listed.map((market) => ({
        market,
        term: termOf(marketStatus(market, now), market.resolveAfter, now),
        resolveAfter: market.resolveAfter,
        dayKey: market.dayKey,
        threshold: market.threshold,
      })),
    );
    return TERMS.map((term) => ({
      term,
      markets: ordered.filter((entry) => entry.term === term).map((entry) => entry.market),
    })).filter((group) => group.markets.length > 0);
  }, [listed, now]);

  /** An expiry's line beside its date: time left while it trades. */
  const expiryNote = (term: Term, market: Market) => {
    if (term === 'settled' || term === 'awaiting') return null;
    const left = closesIn(market.resolveAfter, now);
    return left ? `Closes in ${left}` : null;
  };

  return (
    <>
      <label className="block lg:hidden">
        <span className="sr-only">Market</span>
        <select
          className="h-11 w-full rounded-[2px] border border-border bg-card px-3 text-sm text-foreground [color-scheme:dark] disabled:text-muted-foreground"
          disabled={!groups}
          onChange={(event) => select(event.target.value as Address)}
          value={selected?.address ?? ''}
        >
          {groups ? (
            // Instrument only: the selected market's prices and status
            // are on the instrument bar just above, and a suffix would be
            // cut off at phone width.
            groups.map((group) => (
              <optgroup key={group.term} label={TERM_LABELS[group.term]}>
                {group.markets.map((market) => (
                  <option key={market.address} value={market.address}>
                    {contractLabel(market)}
                  </option>
                ))}
              </optgroup>
            ))
          ) : (
            <option value="">{emptyText}</option>
          )}
        </select>
      </label>

      <div className="hidden rounded-[2px] border border-border bg-card lg:block">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          <span>Markets</span>
          {listed && <span className="tabular-nums">{listed.length}</span>}
        </div>
        {groups ? (
          <div className="max-h-[640px] overflow-y-auto">
            {groups.map((group) => {
              const settledGroup = group.term === 'settled';
              return (
                <section aria-label={TERM_LABELS[group.term]} key={group.term}>
                  <h3 className="px-3 pt-3 pb-1 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                    {TERM_LABELS[group.term]}
                  </h3>
                  {byExpiry(group.markets).map((expiry) => {
                    const note = expiryNote(group.term, expiry.markets[0]);
                    return (
                      <div className="pb-1" key={expiry.dayKey}>
                        <div className="flex items-baseline justify-between gap-2 px-3 pt-2 font-mono text-[11px] whitespace-nowrap tabular-nums">
                          <span className="text-foreground">{expiryLabel(expiry.dayKey)}</span>
                          {note && <span className="text-muted-foreground">{note}</span>}
                        </div>
                        <div
                          aria-hidden="true"
                          className={cn(
                            CHAIN_ROW,
                            'border-b border-border px-3 pt-1 pb-1 font-mono text-[10px] whitespace-nowrap uppercase tracking-[0.06em] text-muted-foreground',
                          )}
                        >
                          <span>Strike</span>
                          <span className="text-right">{settledGroup ? 'Long paid' : 'Long'}</span>
                          <span className="text-right">{settledGroup ? 'Short paid' : 'Short'}</span>
                        </div>
                        <ul className="divide-y divide-border">
                          {expiry.markets.map((market) => {
                            const active = market.address === selected?.address;
                            const status = marketStatus(market, now);
                            return (
                              <li key={market.address}>
                                <button
                                  aria-pressed={active}
                                  className={cn(
                                    CHAIN_ROW,
                                    'w-full border-l-2 py-2 pr-3 pl-2.5 text-left tabular-nums',
                                    PRESSABLE,
                                    active ? 'border-foreground bg-accent/50' : 'border-transparent hover:bg-accent/25',
                                  )}
                                  onClick={() => select(market.address)}
                                  type="button"
                                >
                                  <span className="font-mono text-[13px] font-medium text-foreground">
                                    <span className="sr-only">{contractLabel(market)}: </span>
                                    {strikeLabel(market)}
                                    {status === 'cancelled' && (
                                      <span className="block text-[10px] font-normal text-muted-foreground">
                                        Cancelled
                                      </span>
                                    )}
                                  </span>
                                  <ChainPrice market={market} side="YES" status={status} />
                                  <ChainPrice market={market} side="NO" status={status} />
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </div>
        ) : (
          <p className="px-3 py-3 text-xs leading-5 text-muted-foreground">{emptyText}</p>
        )}
      </div>
    </>
  );
}
