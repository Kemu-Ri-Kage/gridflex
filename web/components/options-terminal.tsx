'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';

import { DerivativesComingSoon } from '@/components/derivatives-coming-soon';
import {
  CHIP_BUTTON,
  ctaClass,
  QUIET_BUTTON,
  Segmented,
} from '@/components/terminal-ui';
import { useContractWriter } from '@/components/use-contract-writer';
import {
  deployed,
  optionsAbi,
  readOptionsBoard,
  type OptionRow,
  type OptionsBoard,
} from '@/lib/derivatives';
import {
  buyPreview,
  closeLabel,
  dayLabel,
  defaultLimitCents,
  maxPayoutCents,
  strikeGrid,
} from '@/lib/options-view';
import { dollars, mwhLabel, priceCents, sizeUnits } from '@/lib/perp-view';
import { cn } from '@/lib/utils';

const POLL_MS = 30_000;
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function OptionsTerminal() {
  const { options, collateral } = deployed;
  if (!options || !collateral) {
    return (
      <DerivativesComingSoon
        code="TXPOWER options · calls and puts"
        name="Cap your power cost, or floor your revenue"
        lines={[
          'European calls and puts on one Texas day’s average power price, in MWh, settled in mUSDT.',
          'A call pays the day’s average above the strike; a put pays it below. Strikes in $5 steps around the expected price, refreshed every 5 minutes.',
          'Fully backed: buying locks the option’s largest payout in the pool, so every payout is covered.',
          'Orders fill at the next quotes; trading stops at 12:30 Texas time the day before, when the day-ahead auction reveals the price.',
        ]}
        facts={[
          { label: 'Expiries', value: 'next 7 days' },
          { label: 'Strikes', value: '9, in $5 steps' },
          { label: 'Size', value: 'from 0.1 MWh' },
          { label: 'Settles on', value: 'the day’s average' },
        ]}
      />
    );
  }
  return <LiveOptions collateral={collateral} options={options} />;
}

interface Selection {
  dayKey: number;
  strikeCents: number;
  isCall: boolean;
}

function LiveOptions({
  options,
  collateral,
}: {
  options: Address;
  collateral: Address;
}) {
  const writer = useContractWriter();
  const grid = useMemo(
    () => strikeGrid({ floorCents: -5000, capCents: 30_000 }),
    [],
  );
  const [board, setBoard] = useState<OptionsBoard | null>(null);
  const [day, setDay] = useState<number | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [readError, setReadError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const next = await readOptionsBoard(
        options,
        writer.account,
        Date.now(),
        grid,
      );
      setBoard(next);
      setDay((d) => d ?? next.expiries[0]?.dayKey ?? null);
      setReadError(undefined);
    } catch {
      setReadError('Could not read the options from X Layer; retrying.');
    }
  }, [options, writer.account, grid]);

  useEffect(() => {
    // the first read starts from a timer too, so the effect itself sets no state
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  const expiry = board?.expiries.find((e) => e.dayKey === day) ?? null;
  const row =
    selected && expiry?.dayKey === selected.dayKey
      ? expiry.rows.find((r) => r.strikeCents === selected.strikeCents)
      : undefined;

  return (
    <div className="grid flex-1 gap-px bg-border lg:grid-cols-[minmax(0,1fr)_384px]">
      <div className="flex flex-col gap-6 bg-background p-4 sm:p-6">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            TXPOWER options · calls and puts{' '}
            {board?.paused && (
              <span className="ml-2 text-warning">· paused</span>
            )}
          </div>
          <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            Cap your power cost, or floor your revenue
          </h1>
        </div>
        {readError && <p className="text-xs text-warning">{readError}</p>}
        {board && board.expiries.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No day is trading right now.
          </p>
        )}
        {board && board.expiries.length > 0 && (
          <Segmented
            label="Day"
            onChange={(id) => {
              setDay(Number(id));
              setSelected(null);
            }}
            options={board.expiries.map((e) => ({
              id: String(e.dayKey),
              label: dayLabel(e.dayKey),
            }))}
            value={day === null ? null : String(day)}
          />
        )}
        {expiry && (
          <Chain
            closeUtc={expiry.closeUtc}
            onPick={(strikeCents, isCall) =>
              setSelected({ dayKey: expiry.dayKey, strikeCents, isCall })
            }
            rows={expiry.rows}
            selected={selected}
          />
        )}
        {board && board.toClaim.length > 0 && (
          <section>
            <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              Past days to claim
            </h2>
            <ul className="mt-3 space-y-2 text-sm">
              {board.toClaim.map((h) => (
                <li
                  className="flex items-center justify-between gap-3 border-t border-border pt-2 tabular-nums"
                  key={`${h.dayKey}-${h.strikeCents}-${h.isCall}`}
                >
                  <span>
                    {dayLabel(h.dayKey)} {usd(h.strikeCents)}{' '}
                    {h.isCall ? 'call' : 'put'}, {mwhLabel(h.size)}
                  </span>
                  <button
                    className={QUIET_BUTTON}
                    disabled={Boolean(writer.pending)}
                    onClick={async () => {
                      const ok = await writer.send('Claiming', {
                        address: options,
                        abi: optionsAbi,
                        functionName: 'claim',
                        args: [h.dayKey, BigInt(h.strikeCents), h.isCall],
                      });
                      if (ok) void refresh();
                    }}
                    title="Pays once the day's price is final on chain"
                    type="button"
                  >
                    Claim
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <div className="bg-background p-4 sm:p-6">
        {board && selected && row ? (
          <BuyTicket
            band={board.band}
            collateral={collateral}
            onDone={() => void refresh()}
            options={options}
            row={row}
            selection={selected}
            writer={writer}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Pick a call or a put in the chain to buy or sell it.
          </p>
        )}
      </div>
    </div>
  );
}

function Chain({
  rows,
  closeUtc,
  selected,
  onPick,
}: {
  rows: OptionRow[];
  closeUtc: number;
  selected: Selection | null;
  onPick: (strikeCents: number, isCall: boolean) => void;
}) {
  const cell = (strike: number, isCall: boolean, ask: number, bid: number) => (
    <button
      aria-pressed={
        selected?.strikeCents === strike && selected.isCall === isCall
      }
      className={cn(CHIP_BUTTON, 'w-full justify-center')}
      disabled={ask === 0}
      onClick={() => onPick(strike, isCall)}
      type="button"
    >
      {ask === 0 ? '—' : `${bid ? usd(bid) : '—'} / ${usd(ask)}`}
    </button>
  );
  return (
    <section>
      <div className="flex justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        <span>Bid / ask per MWh</span>
        <span>Trading stops {closeLabel(closeUtc)} Texas time</span>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm tabular-nums">
          <thead className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
              <th className="py-2 font-normal">Calls</th>
              <th className="py-2 text-center font-normal">Strike</th>
              <th className="py-2 font-normal">Puts</th>
              <th className="py-2 text-right font-normal">You hold</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr className="border-t border-border" key={r.strikeCents}>
                <td className="py-1.5 pr-2">
                  {cell(r.strikeCents, true, r.callAsk, r.callBid)}
                </td>
                <td className="py-1.5 text-center font-mono">
                  {usd(r.strikeCents)}
                </td>
                <td className="py-1.5 pl-2">
                  {cell(r.strikeCents, false, r.putAsk, r.putBid)}
                </td>
                <td className="py-1.5 text-right text-xs text-muted-foreground">
                  {[
                    r.myCall > 0n && `${mwhLabel(r.myCall)} call`,
                    r.myPut > 0n && `${mwhLabel(r.myPut)} put`,
                  ]
                    .filter(Boolean)
                    .join(', ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BuyTicket({
  options,
  collateral,
  band,
  row,
  selection,
  writer,
  onDone,
}: {
  options: Address;
  collateral: Address;
  band: { floorCents: number; capCents: number };
  row: OptionRow;
  selection: Selection;
  writer: ReturnType<typeof useContractWriter>;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<'buy' | 'sell'>('buy');
  const [size, setSize] = useState('1');
  const [limit, setLimit] = useState('');
  const { isCall, strikeCents, dayKey } = selection;
  const ask = isCall ? row.callAsk : row.putAsk;
  const bid = isCall ? row.callBid : row.putBid;
  const held = isCall ? row.myCall : row.myPut;
  const max = maxPayoutCents(strikeCents, isCall, band);
  const limitCents =
    priceCents(limit) ??
    (mode === 'buy'
      ? defaultLimitCents(ask, max)
      : Math.max(0, bid - Math.max(1, Math.ceil(bid * 0.05))));
  const units = sizeUnits(size);
  const preview = buyPreview({
    size: units,
    askCents: ask,
    limitCents,
    strikeCents,
    isCall,
    band,
  });
  const sellProblem =
    mode === 'sell' &&
    (units === null || units < 100n
      ? 'Size is at least 0.1 MWh.'
      : units > held
        ? `You hold ${mwhLabel(held)}.`
        : bid === 0
          ? 'The pool is not bidding for this option now.'
          : null);

  const submit = async () => {
    if (mode === 'buy') {
      if (preview.problem || !units) return;
      if (!(await writer.ensureAllowance(collateral, options, preview.escrow)))
        return;
      const ok = await writer.send('Buying', {
        address: options,
        abi: optionsAbi,
        functionName: 'requestBuy',
        args: [dayKey, BigInt(strikeCents), isCall, units, BigInt(limitCents)],
      });
      if (ok) onDone();
    } else {
      if (sellProblem || !units) return;
      const ok = await writer.send('Selling', {
        address: options,
        abi: optionsAbi,
        functionName: 'requestSell',
        args: [dayKey, BigInt(strikeCents), isCall, units, BigInt(limitCents)],
      });
      if (ok) onDone();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {dayLabel(dayKey)} · {usd(strikeCents)} {isCall ? 'call' : 'put'}
      </div>
      <p className="text-sm leading-6 text-foreground">
        {isCall
          ? `Pays the day’s average above ${usd(strikeCents)} per MWh, at most ${usd(max)}.`
          : `Pays the day’s average below ${usd(strikeCents)} per MWh, at most ${usd(max)}.`}
      </p>
      <Segmented
        label="Buy or sell"
        onChange={setMode}
        options={[
          { id: 'buy', label: `Buy · ask ${usd(ask)}` },
          { id: 'sell', label: `Sell · bid ${bid ? usd(bid) : '—'}` },
        ]}
        value={mode}
      />
      <label className="block">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Size (MWh)
        </span>
        <input
          className="mt-1.5 h-11 w-full min-w-0 rounded-[2px] border border-border bg-transparent px-3 font-mono text-base tabular-nums text-foreground outline-none focus:border-foreground/60"
          inputMode="decimal"
          onChange={(e) => setSize(e.target.value)}
          value={size}
        />
      </label>
      <label className="block">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          {mode === 'buy' ? 'Most you pay ($/MWh)' : 'Least you accept ($/MWh)'}
        </span>
        <input
          className="mt-1.5 h-11 w-full min-w-0 rounded-[2px] border border-border bg-transparent px-3 font-mono text-base tabular-nums text-foreground outline-none focus:border-foreground/60"
          inputMode="decimal"
          onChange={(e) => setLimit(e.target.value)}
          placeholder={(limitCents / 100).toFixed(2)}
          value={limit}
        />
      </label>
      {mode === 'buy' && units && (
        <dl className="space-y-1.5 border-t border-border pt-3 text-xs tabular-nums">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Cost at the ask</dt>
            <dd>{dollars(preview.costAtAsk)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">
              Held now (refund after the fill)
            </dt>
            <dd>{dollars(preview.escrow)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Most it can pay</dt>
            <dd>{dollars(preview.maxPayout)}</dd>
          </div>
        </dl>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        Fills at the next quotes, within about 5 minutes; beyond your limit it
        cancels and everything comes back.
      </p>
      {(mode === 'buy' ? preview.problem : sellProblem) && (
        <p className="text-xs text-warning">
          {mode === 'buy' ? preview.problem : sellProblem}
        </p>
      )}
      {writer.error && <p className="text-xs text-down">{writer.error}</p>}
      {writer.account ? (
        <button
          className={ctaClass(mode === 'buy' ? 'up' : 'neutral')}
          disabled={
            Boolean(writer.pending) ||
            Boolean(mode === 'buy' ? preview.problem : sellProblem)
          }
          onClick={() => void submit()}
          type="button"
        >
          {writer.pending ??
            (mode === 'buy' ? `Buy ${isCall ? 'call' : 'put'}` : `Sell back`)}
        </button>
      ) : (
        <button
          className={ctaClass()}
          onClick={() => void writer.connect()}
          type="button"
        >
          Connect wallet
        </button>
      )}
    </div>
  );
}
