'use client';

import { SplitBar, Stat, Ticker } from '@/components/terminal-ui';
import { useWeb3 } from '@/components/web3-provider';
import { closesIn } from '@/lib/closes-in';
import { formatCentsShort, formatPrice } from '@/lib/format';
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
import { ticketState } from '@/lib/ticket-state';
import { cn } from '@/lib/utils';

const E18 = 10n ** 18n;

const STATUS_TONE: Record<MarketStatus, string> = {
  trading: 'border-up/40 text-up',
  awaiting: 'border-warning/40 text-warning',
  resolved: 'border-foreground/40 text-foreground',
  cancelled: 'border-border text-muted-foreground',
};

/**
 * The bar's loaded height, reserved before the markets load so the grid
 * below never jumps (CLS). Market names follow one fixed template, so the
 * loaded height only varies with the breakpoint (measured with Geist at
 * 390-1920px): on a phone the question and the pay line wrap to two lines
 * over the quote; from sm each fits on one; from lg the quote sits beside
 * them, and they can wrap to two lines again until xl.
 */
const RESERVED_HEIGHT = 'min-h-[321px] sm:min-h-[208px] lg:min-h-[168px] xl:min-h-[116px]';

/**
 * YES and NO in whole cents over the two-colour bar. The parent keys it
 * by market, so a change of selection swaps the figures in rather than
 * ticking them as if the price had moved.
 */
function Quote({ priceE18 }: { priceE18?: bigint }) {
  const no = priceE18 === undefined ? undefined : E18 - priceE18;
  return (
    <div className="col-span-2 sm:w-48">
      <div className="flex justify-between gap-6">
        <Stat label="YES" size="lg" tone={priceE18 === undefined ? 'text-muted-foreground' : 'text-up'}>
          <Ticker
            numeric={priceE18 === undefined ? undefined : Number(priceE18)}
            value={priceE18 === undefined ? '—' : formatCentsShort(priceE18)}
          />
        </Stat>
        <Stat className="text-right" label="NO" size="lg" tone={no === undefined ? 'text-muted-foreground' : 'text-down'}>
          <Ticker numeric={no === undefined ? undefined : Number(no)} value={no === undefined ? '—' : formatCentsShort(no)} />
        </Stat>
      </div>
      <SplitBar className="mt-2.5" yesPercent={priceE18 === undefined ? undefined : Number(priceE18) / 1e16} />
    </div>
  );
}

export function InstrumentBar() {
  const { markets, selected, error, now } = useMarkets();
  const reading = useOracleReading(selected?.metricIdBytes, selected?.dayKey);
  const { market, snapshot } = useWeb3();

  if (!selected) {
    return (
      <div className={`border-b border-border px-4 py-3 text-xs text-muted-foreground sm:px-6 sm:py-4 ${RESERVED_HEIGHT}`}>
        {error ?? (markets ? 'No contracts listed yet.' : 'Loading…')}
      </div>
    );
  }

  const status = marketStatus(selected, now);
  const left = status === 'trading' ? closesIn(selected.resolveAfter, now) : null;
  // The ticket's read when it describes this market, since it refreshes
  // right after a trade; otherwise the list's poll.
  const fromTicket =
    ticketState(snapshot, market, Math.floor(now / 1000)).ready &&
    market?.toLowerCase() === selected.address.toLowerCase();
  const priceE18 = fromTicket ? snapshot.priceE18 : selected.live?.priceE18;

  return (
    <div
      className={cn(
        'flex flex-col justify-center gap-3 border-b border-border px-4 py-3 sm:gap-4 sm:px-6 sm:py-4 lg:flex-row lg:items-center lg:justify-between lg:gap-10',
        RESERVED_HEIGHT,
      )}
    >
      <div className="terminal-swap min-w-0 lg:flex-1" key={`name-${selected.address}`}>
        {/* The chip is rendered before the live read lands ("…"), so its
            line is already there. On a phone the day takes a line of its
            own, so the chip's line never wraps. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[11px] leading-4 uppercase tracking-[0.14em] text-muted-foreground">
          <span className="basis-full sm:basis-auto">Texas power · {dayLabel(selected.dayKey, true)}</span>
          <span
            className={cn(
              'rounded-[2px] border px-1.5 py-[3px] leading-none',
              status ? STATUS_TONE[status] : 'border-border text-muted-foreground',
            )}
          >
            {statusLabel(selected, now) ?? '…'}
          </span>
          {left && <span className="tabular-nums">Closes in {left}</span>}
        </div>
        <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-foreground sm:mt-2 sm:text-2xl">
          {marketName(selected)}
        </h1>
        <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">{payLine(selected)}</p>
      </div>
      <div
        className="terminal-swap grid shrink-0 grid-cols-2 gap-x-6 gap-y-3 sm:flex sm:items-start sm:gap-8"
        key={`quote-${selected.address}`}
      >
        {status === 'resolved' ? (
          <Stat className="col-span-2 sm:w-48" label="Outcome" size="lg" tone={selected.live?.yesWon ? 'text-up' : 'text-down'}>
            {selected.live?.yesWon ? 'YES' : 'NO'}
          </Stat>
        ) : status === 'cancelled' ? (
          <Stat className="col-span-2 sm:w-48" label="Outcome" size="lg" tone="text-muted-foreground">
            Cancelled
          </Stat>
        ) : (
          <Quote priceE18={priceE18} />
        )}
        <Stat label="Strike">{formatPrice(selected.threshold)}</Stat>
        {/* The underlying price (design-brief.md §8): the oracle reading
            once the market's day is published; until then, the latest
            daily Texas power price, dated so it never reads as this
            market's own. Blank while the oracle read is in flight, at the
            width it will take, so nothing beside it moves. */}
        <Stat
          className="sm:min-w-[8.5rem]"
          label={
            reading
              ? 'Oracle reading'
              : reading === null
                ? `Texas power ${dayLabel(priceSummary.latestDay.dayKey)}`
                : ' '
          }
        >
          {reading === undefined ? (
            ' '
          ) : (
            <>
              {formatPrice(reading ? reading.value : priceSummary.latestDay.value)}
              <span className="ml-0.5 text-xs text-muted-foreground">/MWh</span>
            </>
          )}
        </Stat>
      </div>
    </div>
  );
}
