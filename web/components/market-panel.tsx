import { FEATURED_MARKET } from '@/lib/market-copy';

/**
 * A single-market panel, not a selector: shared/demo-markets.md lists six
 * candidate markets, but shared/addresses.json shows none of them deployed
 * yet (BinaryMarket/YesToken/NoToken are all empty). A dropdown across six
 * markets that don't exist on chain would be a fake selector; this shows
 * the one market with real evidence behind it instead, plainly labeled.
 */
export function MarketPanel() {
  return (
    <div className="border border-border bg-card">
      <div className="border-b border-border px-3 py-2 font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground">
        Market
      </div>
      <div className="border-l-2 border-foreground bg-accent/40 px-3 py-3">
        <div className="text-sm font-medium text-foreground">{FEATURED_MARKET.name}</div>
        <div className="mt-1 font-mono text-xs text-muted-foreground">
          {FEATURED_MARKET.metricId}
        </div>
      </div>
      <p className="px-3 py-3 text-xs leading-5 text-muted-foreground">
        More contracts appear here as they&rsquo;re listed.
      </p>
    </div>
  );
}
