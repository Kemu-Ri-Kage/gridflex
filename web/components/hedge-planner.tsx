'use client';

import { useMemo, useState } from 'react';

import { ctaClass, Segmented, Stat } from '@/components/terminal-ui';
import type { CommittedRecord } from '@/lib/feed-data';
import {
  dailyEnergy,
  optionHedge,
  perpHedge,
  scenarios,
  SCENARIO_PRICES,
  type Load,
  type Role,
} from '@/lib/hedge-v2';
import { bandedCall, bandedPut, forwardAndSigma } from '@/lib/option-pricing';
import { cn } from '@/lib/utils';
import recordsJson from '@/public/data/ERCOT_HBNORTH_DA_AVG.json';

const BAND = { floor: -50, cap: 300 };
const money = (v: number) =>
  `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
const price = (v: number) => `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`;

/** Daily averages in $/MWh, oldest first, as the site was built with. */
const history = (recordsJson as CommittedRecord[])
  .toSorted((a, b) => a.dayKey - b.dayKey)
  .map((r) => r.value / 100);

function numberOr(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Hedge calculator v2: the power to hedge in, a trade in either market out,
 * with the day's cost or revenue at a range of prices with and without it.
 * Pure calculation from the committed price history, so it works before the
 * futures and options contracts are deployed.
 */
export function HedgePlanner() {
  const model = useMemo(() => forwardAndSigma(history, null), []);
  const forward = model?.forward ?? 40;
  const sigma = model?.sigma ?? 10;

  const [role, setRole] = useState<Role>('buyer');
  const [goal, setGoal] = useState<'lock' | 'cap'>('lock');
  const [mw, setMw] = useState('10');
  const [hours, setHours] = useState('24');
  const [share, setShare] = useState('100');
  const [level, setLevel] = useState('');

  const load: Load = {
    role,
    mw: numberOr(mw, 0),
    hoursPerDay: numberOr(hours, 0),
    share: numberOr(share, 0) / 100,
  };
  const energy = dailyEnergy(load);
  const defaultLevel =
    goal === 'lock'
      ? forward
      : Math.round((role === 'buyer' ? forward + 15 : forward - 10) / 5) * 5;
  const chosen = numberOr(level || String(defaultLevel), defaultLevel);
  const premium =
    goal === 'cap'
      ? role === 'buyer'
        ? bandedCall(forward, chosen, sigma, BAND)
        : bandedPut(forward, chosen, sigma, BAND)
      : 0;
  const hedge =
    goal === 'lock'
      ? perpHedge(load, chosen, BAND)
      : optionHedge(load, chosen, premium);
  const rows = scenarios(load, hedge, SCENARIO_PRICES, BAND);
  const word = role === 'buyer' ? 'cost' : 'revenue';

  return (
    <section className="mx-auto w-full max-w-[1100px] px-4 py-8 sm:px-6 lg:py-12">
      <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        Hedge calculator
      </div>
      <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
        Hedge your Texas power {role === 'buyer' ? 'bill' : 'revenue'}
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
        Expected day average {price(forward)}/MWh from the last{' '}
        {Math.min(14, history.length)} days, uncertainty about {price(sigma)}.
        Option prices here are estimates from the same model the quote bot uses;
        the screen to trade shows the live quotes.
      </p>

      <div className="mt-8 grid gap-8 lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Segmented
            label="Role"
            onChange={setRole}
            options={[
              { id: 'buyer', label: 'I use power' },
              { id: 'producer', label: 'I produce power' },
            ]}
            value={role}
          />
          <div className="grid grid-cols-3 gap-3">
            <Field label="MW" onChange={setMw} value={mw} />
            <Field label="Hours/day" onChange={setHours} value={hours} />
            <Field label="Hedge %" onChange={setShare} value={share} />
          </div>
          <Segmented
            label="Goal"
            onChange={(g) => {
              setGoal(g);
              setLevel('');
            }}
            options={[
              { id: 'lock', label: 'Lock a price' },
              {
                id: 'cap',
                label: role === 'buyer' ? 'Cap my cost' : 'Set a floor',
              },
            ]}
            value={goal}
          />
          <Field
            label={
              goal === 'lock'
                ? 'Price to lock ($/MWh)'
                : role === 'buyer'
                  ? 'Cap at ($/MWh)'
                  : 'Floor at ($/MWh)'
            }
            onChange={setLevel}
            placeholder={defaultLevel.toFixed(2)}
            value={level}
          />
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4">
            <Stat label="Energy a day">{`${Math.round(energy.mwh).toLocaleString('en-US')} MWh`}</Stat>
            <Stat label="Hedged a day">{`${Math.round(energy.hedgedMwh).toLocaleString('en-US')} MWh`}</Stat>
            {hedge.kind === 'perp' ? (
              <>
                <Stat label="Trade">{`${hedge.side === 'long' ? 'Long' : 'Short'} perpetual`}</Stat>
                <Stat label="Collateral">{money(hedge.collateral)}</Stat>
              </>
            ) : (
              <>
                <Stat label="Trade">{`${hedge.type === 'call' ? 'Calls' : 'Puts'} at ${price(hedge.strike)}`}</Stat>
                <Stat label="Premium a day">{money(hedge.premium)}</Stat>
                <Stat label={role === 'buyer' ? 'Worst price' : 'Floor price'}>
                  {price(hedge.effectivePrice)}
                </Stat>
              </>
            )}
          </div>
          <a
            className={ctaClass(role === 'buyer' ? 'up' : 'down')}
            href={goal === 'lock' ? '/futures' : '/options'}
          >
            {goal === 'lock'
              ? 'Open the futures screen'
              : 'Open the options screen'}
          </a>
        </div>

        <div className="min-w-0">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Your {word} for one day, by the day&apos;s average price
          </h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-sm tabular-nums">
              <thead className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                <tr>
                  <th className="py-2 font-normal">Price $/MWh</th>
                  <th className="py-2 text-right font-normal">Without hedge</th>
                  <th className="py-2 text-right font-normal">With hedge</th>
                  <th className="py-2 text-right font-normal">Difference</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const better =
                    role === 'buyer'
                      ? r.unhedged - r.hedged
                      : r.hedged - r.unhedged;
                  return (
                    <tr className="border-t border-border" key={r.price}>
                      <td className="py-2">{price(r.price)}</td>
                      <td className="py-2 text-right">{money(r.unhedged)}</td>
                      <td className="py-2 text-right text-foreground">
                        {money(r.hedged)}
                      </td>
                      <td
                        className={cn(
                          'py-2 text-right',
                          better > 0
                            ? 'text-up'
                            : better < 0
                              ? 'text-down'
                              : 'text-muted-foreground',
                        )}
                      >
                        {better === 0
                          ? '—'
                          : `${better > 0 ? '+' : ''}${money(better)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            Both markets settle on prices inside −$50 to $300, so beyond that
            the hedge stops paying more. The hub price is not your own
            connection point, and a flat daily average does not follow a solar
            or night-time profile. Fees and funding are not included. X Layer
            testnet, test money only.
          </p>
        </div>
      </div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <input
        className="mt-1.5 h-11 w-full min-w-0 rounded-[2px] border border-border bg-transparent px-3 font-mono text-base tabular-nums text-foreground outline-none focus:border-foreground/60"
        inputMode="decimal"
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </label>
  );
}
