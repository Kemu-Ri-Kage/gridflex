'use client';

import * as React from 'react';
import { formatUnits } from 'viem';

import {
  CHIP_BUTTON,
  CtaArrow,
  ctaClass,
  PRESSABLE,
} from '@/components/terminal-ui';
import { Input } from '@/components/ui/input';
import {
  useWeb3,
  type SwitchQuote,
  type TradeSide,
} from '@/components/web3-provider';
import { formatTokenExact } from '@/lib/format';
import { formatUtc } from '@/lib/markets';
import type { TicketState } from '@/lib/ticket-state';
import {
  parsePositiveTokenAmount,
  percentOfBalance,
  SWITCH_PERCENTAGES,
} from '@/lib/trade';
import { cn } from '@/lib/utils';

function tokenUnits(value: string): bigint | undefined {
  try {
    return parsePositiveTokenAmount(value);
  } catch {
    return undefined;
  }
}

/**
 * Switch position: swap YES into NO or NO into YES through the market's
 * pool. It changes side and nothing else - no mUSDT comes back, because
 * BinaryMarket has no way to exit into mUSDT before settlement (swap() only
 * trades one outcome token for the other; redeem() needs a settled market).
 * Same 0.50% slippage protection and 5-minute deadline as a buy.
 */
export function SwitchPosition({
  state,
  blocked,
}: {
  state: TicketState;
  /** An unfinished order exists, so no new action may start. */
  blocked: boolean;
}) {
  const {
    account,
    market,
    snapshot,
    pendingAction,
    quoteSwitch,
    switchPosition,
  } = useWeb3();
  const [chosenFrom, setChosenFrom] = React.useState<TradeSide>();
  const [amount, setAmount] = React.useState('');
  const [quoteState, setQuoteState] = React.useState<{
    key: string;
    quote?: SwitchQuote;
    unavailable: boolean;
  }>({ key: '', unavailable: false });

  const held = { YES: snapshot.yesBalance, NO: snapshot.noBalance };
  // Until a direction is chosen, start from the side the wallet holds more of.
  const from: TradeSide = chosenFrom ?? (held.NO > held.YES ? 'NO' : 'YES');
  const to: TradeSide = from === 'YES' ? 'NO' : 'YES';
  const units = tokenUnits(amount);
  const overHeld = units !== undefined && units > held[from];
  const { ready, settled, tradingOpen } = state;
  const quoteKey = `${market ?? ''}:${from}:${amount}`;

  React.useEffect(() => {
    if (!tradingOpen || units === undefined || overHeld) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void quoteSwitch(from, amount)
        .then((quote) => {
          if (!cancelled)
            setQuoteState({ key: quoteKey, quote, unavailable: false });
        })
        .catch(() => {
          if (!cancelled) setQuoteState({ key: quoteKey, unavailable: true });
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    tradingOpen,
    units,
    overHeld,
    quoteKey,
    quoteSwitch,
    from,
    amount,
    snapshot.priceE18,
  ]);

  const quote = quoteState.key === quoteKey ? quoteState.quote : undefined;
  const quoteUnavailable =
    quoteState.key === quoteKey && quoteState.unavailable;
  const busy = Boolean(pendingAction);
  const canSwitch = Boolean(
    account && tradingOpen && quote && !overHeld && !busy && !blocked,
  );

  let reason: string | undefined;
  if (ready && settled) {
    reason = snapshot.cancelled
      ? 'This market is cancelled. Switching is closed; redeem instead.'
      : 'This market is resolved. Switching is closed; redeem instead.';
  } else if (ready && !tradingOpen) {
    reason = `Trading closed ${formatUtc(snapshot.resolveAfter)}. The contract refuses swaps from then on; hold to settlement and redeem.`;
  } else if (account && ready && held[from] === 0n) {
    reason = `No ${from} held on this market.`;
  } else if (overHeld) {
    reason = `More than the ${formatTokenExact(held[from])} ${from} held.`;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {(['YES', 'NO'] as const).map((side) => (
          <button
            aria-pressed={from === side}
            className={cn(
              'flex h-16 flex-col items-start justify-between rounded-[2px] border px-3 py-2.5 text-left',
              PRESSABLE,
              from === side
                ? 'border-foreground bg-accent text-foreground'
                : 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground',
            )}
            key={side}
            onClick={() => {
              setChosenFrom(side);
              setAmount('');
            }}
            type="button"
          >
            <span className="font-mono text-[11px] uppercase tracking-[0.14em]">
              {side} → {side === 'YES' ? 'NO' : 'YES'}
            </span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {account && ready
                ? `${formatTokenExact(held[side])} ${side} held`
                : '—'}
            </span>
          </button>
        ))}
      </div>

      <div>
        <label
          className="mb-2 block font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
          htmlFor="switch-amount"
        >
          Amount of {from} to switch
        </label>
        <div className="relative">
          <Input
            aria-invalid={amount !== '' && (units === undefined || overHeld)}
            className="h-12 rounded-[2px] border-border bg-background pr-14 font-mono text-xl tabular-nums text-foreground shadow-none focus-visible:border-foreground/50 focus-visible:ring-0 aria-invalid:ring-0 md:text-xl"
            disabled={!tradingOpen}
            id="switch-amount"
            inputMode="decimal"
            min="0"
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0"
            step="0.01"
            type="number"
            value={amount}
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground">
            {from}
          </span>
        </div>
        <div className="mt-2 flex gap-1.5">
          {SWITCH_PERCENTAGES.map((percent) => (
            <button
              aria-pressed={
                units !== undefined &&
                units === percentOfBalance(held[from], percent)
              }
              className={cn(CHIP_BUTTON, 'flex-1')}
              disabled={!tradingOpen || !account || held[from] === 0n}
              key={percent}
              onClick={() =>
                setAmount(formatUnits(percentOfBalance(held[from], percent), 6))
              }
              type="button"
            >
              {percent}%
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5 border-t border-border pt-3 font-mono text-xs">
        <dl className="space-y-1">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">You give</dt>
            <dd className="text-foreground tabular-nums">
              {quote ? `${formatTokenExact(quote.amountIn)} ${from}` : '—'}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">You get</dt>
            <dd className="text-foreground tabular-nums">
              {quote ? `${formatTokenExact(quote.amountOut)} ${to}` : '—'}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Minimum</dt>
            <dd className="text-foreground tabular-nums">
              {quote ? `${formatTokenExact(quote.minimumOut)} ${to}` : '—'}
            </dd>
          </div>
        </dl>
        <div className="text-[11px] text-muted-foreground">
          Slippage 0.5% · 5-min deadline
          {quoteUnavailable && (
            <span className="ml-2 text-warning">Live quote unavailable.</span>
          )}
        </div>
      </div>

      <p className="text-xs leading-5 text-muted-foreground">Changes side.</p>

      {reason && (
        <output className="block border-l-2 border-warning bg-warning/5 py-1.5 pr-2 pl-3 text-xs leading-5 text-warning">
          {reason}
        </output>
      )}

      {account && (
        <button
          className={ctaClass('neutral')}
          disabled={!canSwitch}
          onClick={() => {
            if (!quote) return;
            // Cleared once it confirms, so the reverse switch, now the side
            // held more of, is never one click away with the same amount.
            void switchPosition(from, amount, quote.minimumOut).then(
              (switched) => {
                if (switched) setAmount('');
              },
            );
          }}
          type="button"
        >
          {ready && !tradingOpen ? (
            'Trading closed'
          ) : (
            <>
              {quote
                ? `Switch ${formatTokenExact(quote.amountIn)} ${from} to ${to}`
                : `Switch ${from} to ${to}`}
              <CtaArrow />
            </>
          )}
        </button>
      )}
    </div>
  );
}
