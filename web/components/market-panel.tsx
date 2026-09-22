'use client';

import { marketName, statusLabel, useMarkets } from '@/lib/markets';

/**
 * The listed YES/NO questions on the Texas power price, each named and
 * labelled from its own contract state - never a hand-typed list
 * (design-brief.md §5, §6, §8).
 */
export function MarketPanel() {
  const { markets, selected, select, error, now } = useMarkets();

  return (
    <div className="border border-border bg-card">
      <div className="border-b border-border px-3 py-2 font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground">
        Markets
      </div>
      {markets && markets.length > 0 ? (
        <ul>
          {markets.map((market) => {
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
        <p className="px-3 py-3 text-xs leading-5 text-muted-foreground">
          {error ?? (markets ? 'No contracts listed yet.' : 'Loading…')}
        </p>
      )}
    </div>
  );
}
