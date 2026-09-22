'use client';

import { formatPrice } from '@/lib/format';
import {
  marketName,
  marketStatus,
  payLine,
  statusLabel,
  useMarkets,
  useOracleReading,
  type MarketStatus,
} from '@/lib/markets';

const STATUS_TONE: Record<MarketStatus, string> = {
  trading: 'border-up/40 text-up',
  awaiting: 'border-warning/40 text-warning',
  resolved: 'border-foreground/40 text-foreground',
  cancelled: 'border-border text-muted-foreground',
};

export function InstrumentBar() {
  const { markets, selected, error, now } = useMarkets();
  const reading = useOracleReading(selected?.metricIdBytes, selected?.dayKey);

  if (!selected) {
    return (
      <div className="border-b border-border px-4 py-3 text-xs text-muted-foreground sm:px-6">
        {error ?? (markets ? 'No contracts listed yet.' : 'Loading…')}
      </div>
    );
  }

  const status = marketStatus(selected, now);
  const basis = selected.metricId === 'ERCOT_WEST_NORTH_DA_BASIS';

  return (
    <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-lg font-semibold tracking-tight text-foreground sm:text-xl">
            {marketName(selected)}
          </h1>
          {status && (
            <span
              className={
                'border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] ' +
                STATUS_TONE[status]
              }
            >
              {statusLabel(selected, now)}
            </span>
          )}
        </div>
        <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
          {payLine(selected)}
        </p>
      </div>
      <div className="font-mono text-xs tabular-nums text-muted-foreground sm:text-right">
        <div>Strike {formatPrice(selected.threshold, undefined, basis)}</div>
        {reading && (
          <div className="mt-0.5 text-foreground">
            Oracle reading {formatPrice(reading.value, 'MWh', basis)}
          </div>
        )}
        <div className="mt-0.5 text-[10px] text-muted-foreground/70">
          dayKey {selected.dayKey}
        </div>
      </div>
    </div>
  );
}
