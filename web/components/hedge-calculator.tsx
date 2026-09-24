'use client';

import * as React from 'react';
import type { Address } from 'viem';

import {
  CHIP_BUTTON,
  CountTo,
  CtaArrow,
  ctaClass,
  Segmented,
  Stat,
} from '@/components/terminal-ui';
import { Input } from '@/components/ui/input';
import { formatPercent } from '@/lib/format';
import type { HedgeScenario } from '@/lib/hedge';
import {
  hedgeView,
  inputNumber,
  STRIP_DAYS,
  stripView,
  tradingDays,
  type HedgeMarket,
  type HedgeRow,
} from '@/lib/hedge-view';
import {
  dayLabel,
  marketStatus,
  readPoolReserves,
  useMarkets,
  type Market,
  type PoolReserves,
} from '@/lib/markets';
import { prefillTicket } from '@/lib/ticket-prefill';
import { cn } from '@/lib/utils';

/**
 * For the buyer the product is built for: a Texas bitcoin miner or data
 * centre whose largest cost is the Texas power price. Sizes YES on every
 * strike trading on the selected day so the payout follows the load's
 * extra power cost up to a chosen price (lib/hedge.ts), costs each rung
 * from its market's pool, and loads a rung into the order ticket. A week
 * strip repeats that ladder on each of the next market days, each its own
 * next-day market. Nothing is sent from here: the ticket quotes and sends
 * the order.
 */

/** The Hedge tab's two sizes: the selected day's ladder, or the week strip. */
const MODES = [
  { id: 'day', label: 'One day' },
  { id: 'strip', label: 'Week strip' },
] as const;

/** A table's column label: the landing page's small mono caps, muted. */
const HEAD_CELL = 'py-2 font-mono text-[11px] font-normal uppercase tracking-[0.14em] text-muted-foreground';

/** A table row answers the pointer, so the eye can follow it across. */
const ROW = 'transition-colors duration-150 hover:bg-accent/25';

/** A headline figure's tile on the hairline grid. */
const FIGURE_TILE = 'bg-card px-3 py-3';

/**
 * The bottom panel's Hedge tab. It sits full width below the chart rather
 * than in the order column, where its tables made the terminal's row, and
 * so the chart, far taller than one screen.
 */
export function HedgeCalculator() {
  const { markets, error, selected, select, now } = useMarkets();
  const [mode, setMode] = React.useState<'day' | 'strip'>('day');
  const [mw, setMw] = React.useState('10');
  const [hours, setHours] = React.useState('24');
  const [protectTo, setProtectTo] = React.useState('80');

  const trading = React.useMemo(
    () => markets?.filter((m) => marketStatus(m, now) === 'trading') ?? [],
    [markets, now],
  );
  const day = selected?.dayKey;
  const dayMarkets = React.useMemo(
    () => trading.filter((m) => m.dayKey === day),
    [trading, day],
  );
  // A week strip: the first STRIP_DAYS days with a market trading.
  const stripDays = React.useMemo(
    () => tradingDays(trading).slice(0, STRIP_DAYS).map((m) => m.dayKey),
    [trading],
  );
  const stripMarkets = React.useMemo(
    () => trading.filter((m) => stripDays.includes(m.dayKey)),
    [trading, stripDays],
  );
  const poolMarkets = mode === 'strip' ? stripMarkets : dayMarkets;
  const pools = usePools(poolMarkets, now);

  if (!markets || markets.some((m) => !m.live)) {
    return <p className="text-muted-foreground">{error ?? 'Loading…'}</p>;
  }

  // Strikes are in cents on chain, the same x100 scale as oracle readings.
  const hedgeMarket = (market: Market): HedgeMarket => {
    const reserves = pools.reserves?.[poolMarkets.indexOf(market)];
    return {
      address: market.address,
      strike: market.threshold / 100,
      yesReserve: reserves?.yes,
      noReserve: reserves?.no,
    };
  };
  const load = (row: HedgeRow) => {
    if (!row.amount) return;
    select(row.address as Address);
    prefillTicket({ market: row.address, side: 'YES', amount: row.amount });
    // The ticket is above this panel: bring it into view.
    document.getElementById('order-ticket')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const inputs = (
    <div className="grid grid-cols-3 items-end gap-2">
      <NumberField id="hedge-mw" label="Load" onChange={setMw} unit="MW" value={mw} />
      <NumberField id="hedge-hours" label="Hours a day" max="24" onChange={setHours} value={hours} />
      <NumberField id="hedge-protect" label="Protect to" onChange={setProtectTo} unit="$/MWh" value={protectTo} />
    </div>
  );
  const modes = <Segmented label="Hedge mode" onChange={setMode} options={MODES} value={mode} />;
  const terms = (
    <p className="leading-5 text-muted-foreground">
      Each day settles on that day&apos;s average Texas power price and pays 1 mUSDT per YES above
      its strike. Costs are indicative, from each pool now: the ticket&apos;s own quote is what&apos;s
      sent, and large orders move the price.
    </p>
  );

  if (mode === 'strip') {
    const strip = stripView(
      inputNumber(mw),
      inputNumber(hours),
      inputNumber(protectTo),
      stripDays.map((dayKey) => ({
        dayKey,
        markets: stripMarkets.filter((m) => m.dayKey === dayKey).map(hedgeMarket),
      })),
    );
    const first = strip.days[0]?.dayKey;
    const last = strip.days.at(-1)?.dayKey;
    return (
      <>
        {modes}
        <p className="leading-5 text-muted-foreground">
          The same ladder on each of the next {stripDays.length} market days
          {first && last ? `, ${dayLabel(first)} to ${dayLabel(last)}` : ''}. Every day is its own
          market and settles that afternoon, so the cover rolls day by day and nothing is locked
          up for long.
        </p>
        {inputs}
        {strip.problem === 'load' && (
          <p className="text-warning">Enter a load above 0 MW for up to 24 hours a day.</p>
        )}
        {strip.problem === 'protect' && (
          <p className="text-warning">Protect to a price above the strikes on offer.</p>
        )}
        {!strip.problem && (
          <>
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[2px] border border-border bg-border sm:grid-cols-3">
              <Stat className={FIGURE_TILE} label="Daily load">
                <CountTo format={amountText} value={strip.mwh} />
                <Unit>MWh</Unit>
              </Stat>
              <Stat className={FIGURE_TILE} label="Days covered">
                {strip.days.length}
              </Stat>
              <Stat className={cn(FIGURE_TILE, 'col-span-2 sm:col-span-1')} label="Est. cost">
                <CostFigure cents={strip.totalCents} />
              </Stat>
            </div>
            <table className="w-full font-mono tabular-nums">
              <thead>
                <tr className="border-b border-border">
                  <th className={`${HEAD_CELL} text-left`}>Day</th>
                  <th className={`${HEAD_CELL} text-left`}>Strike</th>
                  <th className={`${HEAD_CELL} text-right text-up`}>YES</th>
                  <th className={`${HEAD_CELL} text-right`}>Est. cost</th>
                  <th className={HEAD_CELL}>
                    <span className="sr-only">Order</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {strip.days.flatMap(({ dayKey, view }) =>
                  view.rows.map((row, i) => (
                    <tr className={ROW} key={row.address}>
                      <td className="py-2 text-muted-foreground">{i === 0 ? dayLabel(dayKey) : ''}</td>
                      <td className="py-2 text-foreground">{dollars(row.strike)}</td>
                      <td className="py-2 text-right text-foreground">{amountText(row.tokens)}</td>
                      <td className="py-2 text-right text-foreground">
                        {row.costCents === undefined ? '—' : amountText(row.costCents / 100, 2)}
                      </td>
                      <td className="py-1.5 pl-3 text-right">
                        <LoadButton onLoad={() => load(row)} row={row} />
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
              <tfoot>
                <tr className="border-t border-border">
                  <td className={`${HEAD_CELL} align-baseline`} colSpan={3}>
                    Total
                  </td>
                  <td className="py-2 text-right text-foreground">
                    {strip.totalCents === undefined ? '—' : amountText(strip.totalCents / 100, 2)}
                  </td>
                  <td className="py-2 pl-3 text-left text-muted-foreground">mUSDT</td>
                </tr>
              </tfoot>
            </table>
            {strip.skipped.length > 0 && (
              <p className="text-muted-foreground">
                Not covered: {strip.skipped.map((d) => dayLabel(d)).join(', ')}, with no strike
                below {dollars(inputNumber(protectTo))}.
              </p>
            )}
            {pools.failed && (
              <p className="text-warning">
                Could not read the pools from X Layer; costs will fill in on the next refresh.
              </p>
            )}
            <ScenarioTable
              caption={`If every day settles at the price: the extra power cost above ${dollars(strip.from ?? 0)}/MWh against what the ladders pay, over ${strip.days.length} days, in mUSDT`}
              payLabel="Strip pays"
              scenarios={strip.scenarios}
            />
          </>
        )}
        {terms}
      </>
    );
  }

  if (day === undefined || dayMarkets.length === 0) {
    return (
      <>
        {modes}
        <NoMarketsOnDay day={day} onSelect={select} trading={trading} />
      </>
    );
  }

  const strikes = dayMarkets.map((market) => market.threshold / 100);
  const view = hedgeView(inputNumber(mw), inputNumber(hours), inputNumber(protectTo), dayMarkets.map(hedgeMarket));

  return (
    <>
      {modes}
      <p className="leading-5 text-muted-foreground">
        YES on every strike for {dayLabel(day, true)}, sized so the payout
        follows a load&apos;s extra power cost up to the price you protect.
      </p>
      {inputs}

      {view.problem === 'load' && (
        <p className="text-warning">
          Enter a load above 0 MW for up to 24 hours a day.
        </p>
      )}
      {view.problem === 'protect' && (
        <p className="text-warning">
          Protect to a price above the lowest strike,{' '}
          {dollars(Math.min(...strikes))}.
        </p>
      )}

      {!view.problem && (
        <>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[2px] border border-border bg-border">
            <Stat className={FIGURE_TILE} label="Daily load">
              <CountTo format={amountText} value={view.mwh} />
              <Unit>MWh</Unit>
            </Stat>
            <Stat className={FIGURE_TILE} label="Est. cost">
              <CostFigure cents={view.totalCents} />
            </Stat>
          </div>

          <table className="w-full font-mono tabular-nums">
            <thead>
              <tr className="border-b border-border">
                <th className={`${HEAD_CELL} text-left`}>Strike</th>
                <th className={`${HEAD_CELL} text-right text-up`}>YES</th>
                <th className={`${HEAD_CELL} text-right`}>Est. cost</th>
                <th className={HEAD_CELL}>
                  <span className="sr-only">Order</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {view.rows.map((row) => (
                <tr className={ROW} key={row.address}>
                  <td className="py-2 text-foreground">
                    {dollars(row.strike)}
                  </td>
                  <td className="py-2 text-right text-foreground">
                    {amountText(row.tokens)}
                  </td>
                  <td className="py-2 text-right text-foreground">
                    {row.costCents === undefined
                      ? '—'
                      : amountText(row.costCents / 100, 2)}
                  </td>
                  <td className="py-1.5 pl-3 text-right">
                    <LoadButton onLoad={() => load(row)} row={row} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border">
                <td className={`${HEAD_CELL} align-baseline`} colSpan={2}>
                  Total
                </td>
                <td className="py-2 text-right text-foreground">
                  {view.totalCents === undefined
                    ? '—'
                    : amountText(view.totalCents / 100, 2)}
                </td>
                <td className="py-2 pl-3 text-left text-muted-foreground">
                  mUSDT
                </td>
              </tr>
            </tfoot>
          </table>
          {pools.failed && (
            <p className="text-warning">
              Could not read the pools from X Layer; costs will fill in on the
              next refresh.
            </p>
          )}

          <ScenarioTable
            caption={`Extra power cost above ${dollars(view.rows[0].strike)}/MWh against what the ladder pays, in mUSDT`}
            payLabel="Ladder pays"
            scenarios={view.scenarios}
          />
        </>
      )}

      {terms}
    </>
  );
}

/** A unit after a headline figure, small and muted so the number leads. */
function Unit({ children }: { children: React.ReactNode }) {
  return <span className="ml-1.5 text-xs text-muted-foreground">{children}</span>;
}

/** A ladder's total cost in mUSDT, counting to each new total; a dash until the pools are read. */
function CostFigure({ cents }: { cents?: number }) {
  if (cents === undefined) return '—';
  return (
    <>
      <CountTo format={costText} value={cents} />
      <Unit>mUSDT</Unit>
    </>
  );
}

/** Each rung's order, a compact YES call to action; it fills the ticket and never sends. */
function LoadButton({ row, onLoad }: { row: HedgeRow; onLoad: () => void }) {
  return (
    <button
      className={cn(ctaClass('up'), 'h-8 w-auto gap-1.5 whitespace-nowrap px-3 text-xs')}
      disabled={!row.amount}
      onClick={onLoad}
      type="button"
    >
      Load in ticket
      <CtaArrow />
    </button>
  );
}

function ScenarioTable({
  caption,
  payLabel,
  scenarios,
}: {
  caption: string;
  payLabel: string;
  scenarios: readonly HedgeScenario[];
}) {
  return (
    <div>
      <div className="mb-2 leading-5 text-muted-foreground">{caption}</div>
      <table className="w-full font-mono tabular-nums">
        <thead>
          <tr className="border-b border-border">
            <th className={`${HEAD_CELL} text-left`}>Price</th>
            <th className={`${HEAD_CELL} text-right`}>Extra cost</th>
            <th className={`${HEAD_CELL} text-right`}>{payLabel}</th>
            <th className={`${HEAD_CELL} text-right`}>Covered</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border text-foreground">
          {scenarios.map((s) => (
            <tr className={ROW} key={s.price}>
              <td className="py-2">{dollars(s.price)}</td>
              <td className="py-2 text-right">${amountText(s.extraCost)}</td>
              <td className="py-2 text-right">{amountText(s.payout)}</td>
              <td className="py-2 text-right">{s.covered === null ? '—' : formatPercent(s.covered, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The day's pools, re-read on each poll of the markets list and never faster. */
function usePools(
  markets: readonly Market[],
  now: number,
): { reserves?: PoolReserves[]; failed?: boolean } {
  const key = markets.map((m) => m.address).join(',');
  const [state, setState] = React.useState<{
    key: string;
    reserves?: PoolReserves[];
    failed?: boolean;
  }>({ key: '' });

  // `now` advances once per markets poll, so it is the refresh tick.
  React.useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void readPoolReserves(key.split(',') as Address[])
      .then((reserves) => {
        if (!cancelled) setState({ key, reserves });
      })
      .catch(() => {
        // Keep the last read for these markets; only say it failed.
        if (!cancelled) {
          setState((previous) => ({
            key,
            reserves: previous.key === key ? previous.reserves : undefined,
            failed: true,
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key, now]);

  return state.key === key ? state : {};
}

function NoMarketsOnDay({
  day,
  trading,
  onSelect,
}: {
  day?: number;
  trading: readonly Market[];
  onSelect: (address: Address) => void;
}) {
  const days = tradingDays(trading);
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground">
        {day !== undefined && `No market trades on ${dayLabel(day, true)}. `}
        {days.length === 0
          ? 'No market is trading right now.'
          : 'Markets are trading on:'}
      </p>
      {days.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {days.map((market) => (
            <button
              className={cn(CHIP_BUTTON, 'text-foreground')}
              key={market.dayKey}
              onClick={() => onSelect(market.address)}
              type="button"
            >
              {dayLabel(market.dayKey)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A labelled input; the unit keeps its own case under the small-caps label. */
function NumberField({
  id,
  label,
  max,
  onChange,
  unit,
  value,
}: {
  id: string;
  label: string;
  max?: string;
  onChange: (value: string) => void;
  unit?: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <label
        className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
        htmlFor={id}
      >
        {label}
        {unit && (
          <>
            , <span className="normal-case">{unit}</span>
          </>
        )}
      </label>
      <Input
        aria-invalid={inputNumber(value) === 0}
        className="h-10 rounded-[2px] border-border bg-background px-3 font-mono text-base tabular-nums text-foreground shadow-none focus-visible:ring-1"
        id={id}
        inputMode="decimal"
        max={max}
        min="0"
        onChange={(event) => onChange(event.target.value)}
        type="number"
        value={value}
      />
    </div>
  );
}

/** "$40", "$39.57": whole dollars without cents. */
function dollars(value: number): string {
  return `$${amountText(value, Number.isInteger(value) ? 0 : 2)}`;
}

/** A cost in cents as mUSDT with 2 decimals, the tables' own format. */
function costText(cents: number): string {
  return amountText(cents / 100, 2);
}

/** Grouped, with exactly `fixed` decimals when given, otherwise up to 2. */
function amountText(value: number, fixed?: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: fixed ?? 0,
    maximumFractionDigits: fixed ?? 2,
  });
}
