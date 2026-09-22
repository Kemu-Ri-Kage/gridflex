'use client';

import type { Address } from 'viem';

import { marketName, statusLabel, useMarkets } from '@/lib/markets';

/**
 * The listed YES/NO questions on the Texas power price, each named and
 * labelled from its own contract state - never a hand-typed list
 * (design-brief.md §5, §6, §8).
 *
 * Below lg the list collapses to one compact dropdown directly under the
 * instrument bar, so the chart follows it on a phone (§10). The dropdown
 * is the same height loading or loaded, so nothing below it shifts.
 */
export function MarketPanel() {
  const { markets, selected, select, error, now } = useMarkets();
  const listed = markets && markets.length > 0 ? markets : null;
  const emptyText = error ?? (markets ? 'No contracts listed yet.' : 'Loading…');

  return (
    <>
      <label className="block lg:hidden">
        <span className="sr-only">Market</span>
        <select
          className="h-10 w-full rounded-[2px] border border-border bg-card px-3 text-sm text-foreground [color-scheme:dark] disabled:text-muted-foreground"
          disabled={!listed}
          onChange={(event) => select(event.target.value as Address)}
          value={selected?.address ?? ''}
        >
          {listed ? (
            // Name only: the selected market's status is on the
            // instrument bar's chip just above, and a status suffix
            // would be cut off at phone width.
            listed.map((market) => (
              <option key={market.address} value={market.address}>
                {marketName(market)}
              </option>
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
        {listed ? (
          <ul>
            {listed.map((market) => {
              const active = market.address === selected?.address;
              return (
                <li key={market.address}>
                  <button
                    aria-pressed={active}
                    className={
                      'w-full border-l-2 px-3 py-3 text-left ' +
                      (active
                        ? 'border-foreground bg-accent/40'
                        : 'border-transparent hover:bg-accent/20')
                    }
                    onClick={() => select(market.address)}
                    type="button"
                  >
                    <div className="text-sm font-medium text-foreground">
                      {marketName(market)}
                    </div>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">
                      {statusLabel(market, now)}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-3 py-3 text-xs leading-5 text-muted-foreground">{emptyText}</p>
        )}
      </div>
    </>
  );
}
