'use client';

import { FEATURED_MARKET, isPastSettlement } from '@/lib/market-copy';
import { useEvidence } from '@/lib/site-data';
import { formatPrice } from '@/lib/format';

export function InstrumentBar() {
  const evidence = useEvidence();
  const past = isPastSettlement(evidence?.marketDayEndUtc);

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
        <div>Strike ${FEATURED_MARKET.strikeDollars.toFixed(2)}</div>
        {evidence && (
          <div className="mt-0.5 text-foreground">
            Oracle reading: {formatPrice(evidence.value, 'MWh')}
          </div>
        )}
        <div className="mt-0.5 text-[10px] text-muted-foreground/70">
          dayKey {FEATURED_MARKET.dayKey}
        </div>
      </div>
    </div>
  );
}
