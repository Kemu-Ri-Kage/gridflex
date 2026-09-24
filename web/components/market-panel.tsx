'use client';

import * as React from 'react';
import type { Address } from 'viem';

import { closesIn } from '@/lib/closes-in';
import { byTerm, TERM_LABELS, TERMS, termOf } from '@/lib/market-term';
import { marketName, marketStatus, statusLabel, useMarkets, type Market } from '@/lib/markets';

/**
 * The listed YES/NO questions on the Texas power price, each named and
 * labelled from its own contract state - never a hand-typed list
 * (design-brief.md §5, §6, §8) - grouped by maturity (lib/market-term.ts):
 * next day, this week, later, then the ones waiting for their price and the
 * settled ones. The same contract at every maturity; a next-day market
 * settles the next afternoon.
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

  const statusLine = (market: Market) => {
    const left = marketStatus(market, now) === 'trading' ? closesIn(market.resolveAfter, now) : null;
    return left ? `Trading · closes in ${left}` : statusLabel(market, now);
  };

  return (
    <>
      <label className="block lg:hidden">
        <span className="sr-only">Market</span>
        <select
          className="h-10 w-full rounded-[2px] border border-border bg-card px-3 text-sm text-foreground [color-scheme:dark] disabled:text-muted-foreground"
          disabled={!groups}
          onChange={(event) => select(event.target.value as Address)}
          value={selected?.address ?? ''}
        >
          {groups ? (
            // Name only: the selected market's status is on the
            // instrument bar's chip just above, and a status suffix
            // would be cut off at phone width.
            groups.map((group) => (
              <optgroup key={group.term} label={TERM_LABELS[group.term]}>
                {group.markets.map((market) => (
                  <option key={market.address} value={market.address}>
                    {marketName(market)}
                  </option>
                ))}
              </optgroup>
            ))
          ) : (
            <option value="">{emptyText}</option>
          )}
        </select>
      </label>

      <div className="hidden border border-border bg-card lg:block">
        <div className="border-b border-border px-3 py-2 font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground">
          Markets
        </div>
        {groups ? (
          <div className="max-h-[640px] overflow-y-auto">
            {groups.map((group) => (
              <section aria-label={TERM_LABELS[group.term]} key={group.term}>
                <h3 className="px-3 pt-3 pb-1 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  {TERM_LABELS[group.term]}
                </h3>
                <ul>
                  {group.markets.map((market) => {
                    const active = market.address === selected?.address;
                    return (
                      <li key={market.address}>
                        <button
                          aria-pressed={active}
                          className={
                            'w-full border-l-2 px-3 py-2.5 text-left ' +
                            (active ? 'border-foreground bg-accent/40' : 'border-transparent hover:bg-accent/20')
                          }
                          onClick={() => select(market.address)}
                          type="button"
                        >
                          <div className="text-sm font-medium text-foreground">{marketName(market)}</div>
                          <div className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
                            {statusLine(market)}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <p className="px-3 py-3 text-xs leading-5 text-muted-foreground">{emptyText}</p>
        )}
      </div>
    </>
  );
}
