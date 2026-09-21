'use client';

import { FEATURED_MARKET } from '@/lib/market-copy';
import { useEvidence } from '@/lib/site-data';
import { formatPrice } from '@/lib/format';

/**
 * The date has already passed regardless of what the oracle evidence file
 * says, so this doesn't block on evidence loading: `Date.now()` alone is
 * enough to know 8 Sep 2026 is behind us. marketDayEndUtc (once loaded) is
 * used only to refine the boundary to the exact Central-day cutoff instead
 * of a UTC calendar-date guess.
 */
function usePastSettlement(marketDayEndUtc?: number): boolean {
  if (marketDayEndUtc) return Date.now() >= marketDayEndUtc * 1000;
  return Date.now() >= new Date(`${FEATURED_MARKET.marketDay}T23:59:59Z`).getTime();
}

export function InstrumentBar() {
  const evidence = useEvidence();
  const past = usePastSettlement(evidence?.marketDayEndUtc);

  return (
    <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="font-mono text-lg font-semibold tracking-tight text-foreground sm:text-xl">
            {FEATURED_MARKET.name}
          </h1>
          <span
            className={
              'border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] ' +
              (past
                ? 'border-warning/40 text-warning'
                : 'border-up/40 text-up')
            }
          >
            {past ? 'past settlement date' : 'trading'}
          </span>
        </div>
        <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
          {FEATURED_MARKET.description}
        </p>
      </div>
      <div className="font-mono text-xs tabular-nums text-muted-foreground sm:text-right">
        <div>
          Strike ${FEATURED_MARKET.strikeDollars.toFixed(2)} · dayKey {FEATURED_MARKET.dayKey}
        </div>
        {evidence && (
          <div className="mt-0.5 text-foreground">
            Oracle reading: {formatPrice(evidence.value, 'MWh')}
          </div>
        )}
      </div>
    </div>
  );
}
