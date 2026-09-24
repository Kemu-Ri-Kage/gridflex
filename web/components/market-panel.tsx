'use client';

import * as React from 'react';
import type { Address } from 'viem';

import { PRESSABLE, SplitBar, Ticker } from '@/components/terminal-ui';
import { closesIn } from '@/lib/closes-in';
import { formatCentsShort } from '@/lib/format';
import { byTerm, TERM_LABELS, TERMS, termOf } from '@/lib/market-term';
import { marketName, marketStatus, statusLabel, useMarkets, type Market, type MarketStatus } from '@/lib/markets';
import { cn } from '@/lib/utils';

/**
 * A row's figure on the right, as wide as a price at most, so the question
 * beside it always fits on two lines: the YES price while trading, the
 * winning side with "won" under it once resolved, a dash while there is
 * no price that means anything (the status line below says why).
 */
function RowQuote({ market, status }: { market: Market; status: MarketStatus | undefined }) {
  const price = market.live?.priceE18;
  if (status === 'resolved') {
    return (
      <>
        <span className={cn('font-mono text-[13px]', market.live?.yesWon ? 'text-up' : 'text-down')}>
          {market.live?.yesWon ? 'YES' : 'NO'}
        </span>
        <span className="font-mono text-[10px] leading-none text-muted-foreground">won</span>
      </>
    );
  }
  if (status !== 'trading' || price === undefined) {
    return <span className="font-mono text-[13px] text-muted-foreground">—</span>;
  }
  return <Ticker className="font-mono text-[13px] text-up" numeric={Number(price)} value={formatCentsShort(price)} />;
}

/**
 * The listed YES/NO questions on the Texas power price, each named and
 * labelled from its own contract state - never a hand-typed list
 * (design-brief.md §5, §6, §8) - grouped by maturity (lib/market-term.ts):
 * next day, this week, later, then the ones waiting for their price and the
 * settled ones. The same contract at every maturity; a next-day market
 * settles the next afternoon. Each row reads as a table row: the question,
 * its YES price, the two-colour bar while it trades, and its time left or
 * status.
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
          className="h-11 w-full rounded-[2px] border border-border bg-card px-3 text-sm text-foreground [color-scheme:dark] disabled:text-muted-foreground"
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

      <div className="hidden rounded-[2px] border border-border bg-card lg:block">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          <span>Markets</span>
          {listed && <span className="tabular-nums">{listed.length}</span>}
        </div>
        {groups ? (
          <div className="max-h-[640px] overflow-y-auto">
            {groups.map((group) => (
              <section aria-label={TERM_LABELS[group.term]} key={group.term}>
                <h3 className="px-3 pt-3 pb-1 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  {TERM_LABELS[group.term]}
                </h3>
                <ul className="divide-y divide-border">
                  {group.markets.map((market) => {
                    const active = market.address === selected?.address;
                    const status = marketStatus(market, now);
                    const price = market.live?.priceE18;
                    return (
                      <li key={market.address}>
                        <button
                          aria-pressed={active}
                          className={cn(
                            'block w-full border-l-2 py-3 pr-2.5 pl-3 text-left',
                            PRESSABLE,
                            active ? 'border-foreground bg-accent/50' : 'border-transparent hover:bg-accent/25',
                          )}
                          onClick={() => select(market.address)}
                          type="button"
                        >
                          <span className="flex items-start justify-between gap-2">
                            <span className="line-clamp-2 text-[13px] leading-snug font-medium text-foreground">
                              {marketName(market)}
                            </span>
                            <span className="flex shrink-0 flex-col items-end leading-snug tabular-nums">
                              <RowQuote market={market} status={status} />
                            </span>
                          </span>
                          {/* The bar only while the price still means
                              something: trading, or not yet read. */}
                          {(status === 'trading' || status === undefined) && (
                            <SplitBar
                              className="mt-2"
                              yesPercent={status === 'trading' && price !== undefined ? Number(price) / 1e16 : undefined}
                            />
                          )}
                          <span className="mt-1.5 block font-mono text-[11px] tabular-nums text-muted-foreground">
                            {statusLine(market)}
                          </span>
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
