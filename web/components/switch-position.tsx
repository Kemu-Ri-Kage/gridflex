'use client';

import * as React from 'react';
import { formatUnits } from 'viem';

import { Button } from '@/components/ui/button';
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
          <Button
            aria-pressed={from === side}
            className="h-auto flex-col items-start gap-0.5 rounded-[2px] border-border bg-background py-2 font-mono shadow-none hover:bg-muted aria-pressed:border-foreground aria-pressed:bg-muted aria-pressed:ring-0"
            key={side}
            onClick={() => {
              setChosenFrom(side);
              setAmount('');
            }}
            variant="outline"
          >
            <span className="text-foreground">
              {side} → {side === 'YES' ? 'NO' : 'YES'}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {account && ready
                ? `${formatTokenExact(held[side])} ${side} held`
                : '—'}
            </span>
          </Button>
        ))}
      </div>

      <div>
        <label
          className="mb-2 block text-xs text-muted-foreground"
          htmlFor="switch-amount"
        >
          Amount of {from} to switch
        </label>
        <div className="relative">
          <Input
            aria-invalid={amount !== '' && (units === undefined || overHeld)}
            className="h-10 rounded-[2px] border-border bg-background pr-14 font-mono text-base text-foreground shadow-none focus-visible:ring-1"
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
          <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground">
            {from}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-2">
          {SWITCH_PERCENTAGES.map((percent) => (
            <Button
              className="h-8 rounded-[2px] font-mono text-xs shadow-none"
              disabled={!tradingOpen || !account || held[from] === 0n}
              key={percent}
              onClick={() =>
                setAmount(formatUnits(percentOfBalance(held[from], percent), 6))
              }
              size="sm"
              variant="outline"
            >
              {percent}%
            </Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 rounded-[2px] border border-border bg-background p-3 text-xs">
        <div>
          <div className="text-muted-foreground">You give</div>
          <div className="mt-1 font-mono text-foreground">
            {quote ? `${formatTokenExact(quote.amountIn)} ${from}` : '—'}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Estimated to receive</div>
          <div className="mt-1 font-mono text-foreground">
            {quote ? `${formatTokenExact(quote.amountOut)} ${to}` : '—'}
          </div>
        </div>
        <div className="col-span-2">
          <div className="text-muted-foreground">Minimum received</div>
          <div className="mt-1 font-mono text-foreground">
            {quote ? `${formatTokenExact(quote.minimumOut)} ${to}` : '—'}
          </div>
        </div>
        <div className="col-span-2 text-muted-foreground">
          0.50% slippage protection · 5-minute deadline
          {quoteUnavailable && (
            <span className="ml-2 text-warning">Live quote unavailable.</span>
          )}
        </div>
      </div>

      <p className="text-xs leading-5 text-muted-foreground">Changes side.</p>

      {reason && (
        <output className="block text-xs leading-5 text-warning">
          {reason}
        </output>
      )}

      {account && (
        <Button
          className="h-10 w-full rounded-[2px] bg-primary text-primary-foreground shadow-none hover:bg-primary/85"
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
        >
          {ready && !tradingOpen
            ? 'Trading closed'
            : quote
              ? `Switch ${formatTokenExact(quote.amountIn)} ${from} to ${to}`
              : `Switch ${from} to ${to}`}
        </Button>
      )}
    </div>
  );
}
