'use client';

import { formatPrice } from '@/lib/format';
import {
  dayLabel,
  marketName,
  marketStatus,
  payLine,
  statusLabel,
  useMarkets,
  useOracleReading,
  type MarketStatus,
} from '@/lib/markets';
import { priceSummary } from '@/lib/price-summary';

const STATUS_TONE: Record<MarketStatus, string> = {
  trading: 'border-up/40 text-up',
  awaiting: 'border-warning/40 text-warning',
  resolved: 'border-foreground/40 text-foreground',
  cancelled: 'border-border text-muted-foreground',
};

/**
 * The bar's loaded height, reserved before the markets load so the grid
 * below never jumps (CLS). Market names follow one fixed template, so the
 * loaded height only varies with the breakpoint: the name wraps to two
 * lines on a phone, and the bar is one row from lg up.
 */
const RESERVED_HEIGHT = 'min-h-[200px] sm:min-h-[154px] lg:min-h-[77px]';

export function InstrumentBar() {
  const { markets, selected, error, now } = useMarkets();
  const reading = useOracleReading(selected?.metricIdBytes, selected?.dayKey);

  if (!selected) {
    return (
      <div
        className={`border-b border-border px-4 py-3 text-xs text-muted-foreground sm:px-6 ${RESERVED_HEIGHT}`}
      >
        {error ?? (markets ? 'No contracts listed yet.' : 'Loading…')}
      </div>
    );
  }

  const status = marketStatus(selected, now);

  return (
    <div
      className={`flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 ${RESERVED_HEIGHT}`}
    >
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-lg font-semibold tracking-tight text-foreground sm:text-xl">
            {marketName(selected)}
          </h1>
          {/* Rendered before the live read lands ("…"), so the chip's
              line is already there and nothing wraps later. */}
          <span
            className={
              'border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] ' +
              (status ? STATUS_TONE[status] : 'border-border text-muted-foreground')
            }
          >
            {statusLabel(selected, now) ?? '…'}
          </span>
        </div>
        <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
          {payLine(selected)}
        </p>
      </div>
      <div className="font-mono text-xs tabular-nums text-muted-foreground sm:text-right">
        <div>Strike {formatPrice(selected.threshold)}</div>
        {/* The underlying price (design-brief.md §8): the oracle reading
            once the market's day is published; until then, the latest
            daily Texas power price, dated so it never reads as this
            market's own. The line keeps its height while the oracle read
            is in flight. */}
        <div className="mt-0.5 text-foreground">
          {reading ? (
            <>Oracle reading {formatPrice(reading.value, 'MWh')}</>
          ) : reading === null ? (
            <>
              Latest Texas power price {formatPrice(priceSummary.latestDay.value, 'MWh')} ·{' '}
              {dayLabel(priceSummary.latestDay.dayKey, true)}
            </>
          ) : (
            '\u00a0'
          )}
        </div>
      </div>
    </div>
  );
}
