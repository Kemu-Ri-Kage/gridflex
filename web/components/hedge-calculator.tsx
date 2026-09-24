'use client';

import * as React from 'react';
import type { Address } from 'viem';

import { Input } from '@/components/ui/input';
import { formatPercent } from '@/lib/format';
import {
  hedgeView,
  inputNumber,
  tradingDays,
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

/**
 * For the buyer the product is built for: a Texas bitcoin miner or data
 * centre whose largest cost is the Texas power price. Sizes YES on every
 * strike trading on the selected day so the payout follows the load's
 * extra power cost up to a chosen price (lib/hedge.ts), costs each rung
 * from its market's pool, and loads a rung into the order ticket. Nothing
 * is sent from here: the ticket quotes and sends the order.
 */

/**
 * The bottom panel's Hedge tab. It sits full width below the chart rather
 * than in the order column, where its tables made the terminal's row, and
 * so the chart, far taller than one screen.
 */
export function HedgeCalculator() {
  const { markets, error, selected, select, now } = useMarkets();
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
  const pools = usePools(dayMarkets, now);

  if (!markets || markets.some((m) => !m.live)) {
    return <p className="text-muted-foreground">{error ?? 'Loading…'}</p>;
  }
  if (day === undefined || dayMarkets.length === 0) {
    return (
      <NoMarketsOnDay
        day={day}
        onSelect={select}
        trading={trading}
      />
    );
  }

  // Strikes are in cents on chain, the same x100 scale as oracle readings.
  const strikes = dayMarkets.map((market) => market.threshold / 100);
  const view = hedgeView(
    inputNumber(mw),
    inputNumber(hours),
    inputNumber(protectTo),
    dayMarkets.map((market, i) => ({
      address: market.address,
      strike: strikes[i],
      yesReserve: pools.reserves?.[i]?.yes,
      noReserve: pools.reserves?.[i]?.no,
    })),
  );

  return (
    <>
      <p className="leading-5 text-muted-foreground">
        YES on every strike for {dayLabel(day, true)}, sized so the payout
        follows a load&apos;s extra power cost up to the price you protect.
      </p>

      <div className="grid grid-cols-3 items-end gap-2">
        <NumberField id="hedge-mw" label="Load, MW" onChange={setMw} value={mw} />
        <NumberField
          id="hedge-hours"
          label="Hours a day"
          max="24"
          onChange={setHours}
          value={hours}
        />
        <NumberField
          id="hedge-protect"
          label="Protect to, $/MWh"
          onChange={setProtectTo}
          value={protectTo}
        />
      </div>

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
          <div className="flex items-baseline justify-between font-mono">
            <span className="text-muted-foreground">Daily load</span>
            <span className="tabular-nums text-foreground">
              {amountText(view.mwh)} MWh
            </span>
          </div>

          <table className="w-full font-mono tabular-nums">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-1.5 text-left font-normal">Strike</th>
                <th className="py-1.5 text-right font-normal">YES</th>
                <th className="py-1.5 text-right font-normal">Est. cost</th>
                <th className="py-1.5">
                  <span className="sr-only">Order</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {view.rows.map((row) => (
                <tr key={row.address}>
                  <td className="py-1.5 text-foreground">
                    {dollars(row.strike)}
                  </td>
                  <td className="py-1.5 text-right text-foreground">
                    {amountText(row.tokens)}
                  </td>
                  <td className="py-1.5 text-right text-foreground">
                    {row.costCents === undefined
                      ? '—'
                      : amountText(row.costCents / 100, 2)}
                  </td>
                  <td className="py-1 pl-2 text-right">
                    <button
                      className="whitespace-nowrap rounded-[2px] border border-border px-2 py-1 text-foreground hover:bg-muted disabled:opacity-50"
                      disabled={!row.amount}
                      onClick={() => {
                        if (!row.amount) return;
                        select(row.address as Address);
                        prefillTicket({
                          market: row.address,
                          side: 'YES',
                          amount: row.amount,
                        });
                        // The ticket is above this panel: bring it into view.
                        document
                          .getElementById('order-ticket')
                          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }}
                      type="button"
                    >
                      Load in ticket
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border">
                <td className="py-1.5 text-muted-foreground" colSpan={2}>
                  Total
                </td>
                <td className="py-1.5 text-right text-foreground">
                  {view.totalCents === undefined
                    ? '—'
                    : amountText(view.totalCents / 100, 2)}
                </td>
                <td className="py-1.5 pl-2 text-left text-muted-foreground">
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

          <div>
            <div className="mb-1 text-muted-foreground">
              Extra power cost above {dollars(view.rows[0].strike)}/MWh
              against what the ladder pays, in mUSDT
            </div>
            <table className="w-full font-mono tabular-nums">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-1.5 text-left font-normal">Price</th>
                  <th className="py-1.5 text-right font-normal">Extra cost</th>
                  <th className="py-1.5 text-right font-normal">Ladder pays</th>
                  <th className="py-1.5 text-right font-normal">Covered</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border text-foreground">
                {view.scenarios.map((s) => (
                  <tr key={s.price}>
                    <td className="py-1.5">{dollars(s.price)}</td>
                    <td className="py-1.5 text-right">
                      ${amountText(s.extraCost)}
                    </td>
                    <td className="py-1.5 text-right">
                      {amountText(s.payout)}
                    </td>
                    <td className="py-1.5 text-right">
                      {s.covered === null ? '—' : formatPercent(s.covered, 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="leading-5 text-muted-foreground">
        Settles on the day&apos;s average Texas power price and pays 1 mUSDT
        per YES above its strike. Costs are indicative, from each pool now:
        the ticket&apos;s own quote is what&apos;s sent, and large orders move
        the price.
      </p>
    </>
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
              className="rounded-[2px] border border-border px-2 py-1 font-mono text-foreground hover:bg-muted"
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

function NumberField({
  id,
  label,
  max,
  onChange,
  value,
}: {
  id: string;
  label: string;
  max?: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <label className="mb-1 block text-muted-foreground" htmlFor={id}>
        {label}
      </label>
      <Input
        aria-invalid={inputNumber(value) === 0}
        className="h-9 rounded-[2px] border-border bg-background px-2 font-mono text-sm tabular-nums text-foreground shadow-none focus-visible:ring-1"
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

/** Grouped, with exactly `fixed` decimals when given, otherwise up to 2. */
function amountText(value: number, fixed?: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: fixed ?? 0,
    maximumFractionDigits: fixed ?? 2,
  });
}
