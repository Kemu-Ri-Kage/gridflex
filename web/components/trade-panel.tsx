'use client';

import * as React from 'react';
import { ArrowUpRight, ExternalLink, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  useWeb3,
  type BuyQuote,
  type TradeSide,
} from '@/components/web3-provider';
import { xLayerTestnet } from '@/lib/contracts';
import { formatToken } from '@/lib/format';
import { marketName, useMarkets } from '@/lib/markets';
import { orderGate, pendingOrderUnits } from '@/lib/pending-order';
import { ticketState } from '@/lib/ticket-state';
import { parsePositiveTokenAmount } from '@/lib/trade';

function validTokenAmount(value: string): boolean {
  try {
    parsePositiveTokenAmount(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The order ticket for the selected market (design-brief.md §5: one
 * product, bought as YES or NO; labels and numbers only). Every number is
 * read from that market's contract through the Web3Provider, which the
 * order column points at the selection.
 */
export function TradePanel() {
  const {
    account,
    configured,
    market,
    snapshot,
    pendingAction,
    error,
    connectError,
    lastTransaction,
    connect,
    mintCollateral,
    quoteBuy,
    buy,
    pendingOrder,
    finishPendingOrder,
    keepBothSides,
    resolve,
    cancel,
    redeem,
  } = useWeb3();
  const { markets, select, now } = useMarkets();
  const [side, setSide] = React.useState<TradeSide>('YES');
  const [amount, setAmount] = React.useState('100');
  const [quoteState, setQuoteState] = React.useState<{
    key: string;
    quote?: BuyQuote;
    unavailable: boolean;
  }>({ key: '', unavailable: false });

  const { ready, settled, closed, cancellable, tradingOpen } = ticketState(
    snapshot,
    market,
    Math.floor(now / 1000),
  );
  const quoteKey = `${market ?? ''}:${side}:${amount}`;

  React.useEffect(() => {
    if (!tradingOpen || !validTokenAmount(amount)) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void quoteBuy(side, amount)
        .then((nextQuote) => {
          if (!cancelled) {
            setQuoteState({
              key: quoteKey,
              quote: nextQuote,
              unavailable: false,
            });
          }
        })
        .catch(() => {
          if (!cancelled) setQuoteState({ key: quoteKey, unavailable: true });
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [tradingOpen, quoteKey, quoteBuy, side, amount, snapshot.priceE18]);

  const validAmount = validTokenAmount(amount);
  const quote = quoteState.key === quoteKey ? quoteState.quote : undefined;
  const quoteUnavailable =
    quoteState.key === quoteKey && quoteState.unavailable;
  const busy = Boolean(pendingAction);
  // An unfinished order anywhere blocks every new one (lib/pending-order.ts).
  const gate = orderGate(pendingOrder, market);
  const pendingMarket = pendingOrder
    ? markets?.find(
        (m) => m.address.toLowerCase() === pendingOrder.market.toLowerCase(),
      )
    : undefined;
  const canBuy = Boolean(
    account && tradingOpen && validAmount && quote && !busy && !gate.blocked,
  );
  const yesPrice = Number(snapshot.priceE18) / 1e16;
  const noPrice = 100 - yesPrice;

  return (
    <Card className="sticky top-3 rounded-[2px] border border-border bg-card py-0 shadow-none ring-0">
      <CardHeader className="rounded-none border-b border-border px-3 py-3">
        <CardTitle className="text-sm font-semibold text-foreground">
          Order ticket
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 px-3 py-4">
        {!configured && (
          <div className="rounded-[2px] border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-5 text-warning">
            Contracts not configured.
          </div>
        )}

        {pendingOrder && (
          <div className="space-y-3 rounded-[2px] border border-warning/40 bg-warning/10 p-3 text-xs">
            <div>
              <div className="font-semibold text-warning">Unfinished order</div>
              {gate.elsewhere && (
                <div className="mt-1 text-foreground">
                  {pendingMarket
                    ? marketName(pendingMarket)
                    : `${pendingOrder.market.slice(0, 6)}…${pendingOrder.market.slice(-4)}`}
                </div>
              )}
              <div className="mt-1 font-mono text-muted-foreground">
                Buy {pendingOrder.side} ·{' '}
                {formatToken(pendingOrderUnits(pendingOrder))} mUSDT · YES + NO
                held
              </div>
            </div>
            <div className="grid gap-2">
              {gate.elsewhere && pendingMarket && (
                <Button
                  className="h-10 rounded-[2px] shadow-none"
                  onClick={() => select(pendingMarket.address)}
                  variant="outline"
                >
                  Go to market
                </Button>
              )}
              {!gate.elsewhere && (
                <Button
                  className="h-auto w-full min-w-0 flex-col items-start gap-0.5 whitespace-normal rounded-[2px] py-2 text-left shadow-none"
                  disabled={busy}
                  onClick={() => void finishPendingOrder()}
                  variant="outline"
                >
                  <span>Finish order</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    All into {pendingOrder.side}
                  </span>
                </Button>
              )}
              {(!gate.elsewhere || !pendingMarket) && (
                <Button
                  className="h-auto w-full min-w-0 flex-col items-start gap-0.5 whitespace-normal rounded-[2px] py-2 text-left shadow-none"
                  disabled={busy}
                  onClick={keepBothSides}
                  variant="outline"
                >
                  <span>Keep both sides</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    1 mUSDT per pair after resolve, either outcome
                  </span>
                </Button>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button
            aria-pressed={side === 'YES'}
            className="h-10 rounded-[2px] border-border bg-background font-mono text-up shadow-none hover:bg-muted aria-pressed:border-up aria-pressed:bg-up/10 aria-pressed:ring-0"
            onClick={() => setSide('YES')}
            variant="outline"
          >
            YES
            <span className="ml-auto font-mono text-xs">
              {ready
                ? `${yesPrice.toFixed(1)}¢ · ${Math.round(yesPrice)}% implied`
                : '—'}
            </span>
          </Button>
          <Button
            aria-pressed={side === 'NO'}
            className="h-10 rounded-[2px] border-border bg-background font-mono text-down shadow-none hover:bg-muted aria-pressed:border-down aria-pressed:bg-down/10 aria-pressed:ring-0"
            onClick={() => setSide('NO')}
            variant="outline"
          >
            NO
            <span className="ml-auto font-mono text-xs">
              {ready
                ? `${noPrice.toFixed(1)}¢ · ${Math.round(noPrice)}% implied`
                : '—'}
            </span>
          </Button>
        </div>

        <div>
          <label
            className="mb-2 block text-xs text-muted-foreground"
            htmlFor="order-amount"
          >
            Amount
          </label>
          <div className="relative">
            <Input
              aria-invalid={!validAmount}
              className="h-10 rounded-[2px] border-border bg-background pr-20 font-mono text-base text-foreground shadow-none focus-visible:ring-1"
              disabled={!tradingOpen}
              id="order-amount"
              inputMode="decimal"
              min="0"
              onChange={(event) => setAmount(event.target.value)}
              step="0.01"
              type="number"
              value={amount}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground">
              mUSDT
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 rounded-[2px] border border-border bg-background p-3 text-xs">
          <div>
            <div className="text-muted-foreground">Estimated output</div>
            <div className="mt-1 font-mono text-foreground">
              {quote ? `${formatToken(quote.totalOut)} ${side}` : '—'}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Minimum received</div>
            <div className="mt-1 font-mono text-foreground">
              {quote ? `${formatToken(quote.minimumTotalOut)} ${side}` : '—'}
            </div>
          </div>
          <div className="col-span-2 text-muted-foreground">
            0.50% slippage protection · 5-minute deadline
            {quoteUnavailable && (
              <span className="ml-2 text-warning">Live quote unavailable.</span>
            )}
          </div>
        </div>

        {!account ? (
          <Button
            className="h-10 w-full rounded-[2px] bg-primary text-primary-foreground shadow-none hover:bg-primary/85"
            onClick={() => void connect()}
          >
            Connect wallet to trade <ArrowUpRight data-icon="inline-end" />
          </Button>
        ) : (
          <div className="grid gap-2">
            <Button
              className={
                'h-10 rounded-[2px] shadow-none ' +
                (side === 'YES'
                  ? 'bg-up text-background hover:bg-up/85'
                  : 'bg-down text-background hover:bg-down/85')
              }
              disabled={!canBuy}
              onClick={() => void buy(side, amount)}
            >
              {ready && !tradingOpen ? 'Trading closed' : `Buy ${side}`}
            </Button>
            <Button
              className="rounded-[2px] shadow-none"
              disabled={!configured || busy}
              onClick={() => void mintCollateral()}
              variant="outline"
            >
              Get 1,000 demo mUSDT
            </Button>
            <div className="grid grid-cols-3 gap-2">
              <Button
                className="rounded-[2px] shadow-none"
                disabled={!closed || settled || busy}
                onClick={() => void resolve()}
                size="sm"
                variant="ghost"
              >
                Resolve
              </Button>
              <Button
                className="rounded-[2px] shadow-none"
                disabled={!cancellable || settled || busy}
                onClick={() => void cancel()}
                size="sm"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                className="rounded-[2px] shadow-none"
                disabled={!settled || busy}
                onClick={() => void redeem()}
                size="sm"
                variant="ghost"
              >
                Redeem
              </Button>
            </div>
          </div>
        )}

        <div aria-live="polite" className="min-h-5 text-xs leading-5">
          {pendingAction && (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> {pendingAction}…
            </span>
          )}
          {!pendingAction &&
            (error ?? (!account ? connectError : undefined)) && (
              <span className="text-down">{error ?? connectError}</span>
            )}
          {!pendingAction && !error && lastTransaction && (
            <a
              className="inline-flex items-center gap-1.5 text-foreground underline-offset-4 hover:underline"
              href={`${xLayerTestnet.blockExplorers.default.url}/tx/${lastTransaction}`}
              rel="noreferrer"
              target="_blank"
            >
              Transaction confirmed <ExternalLink className="size-3" />
            </a>
          )}
        </div>

        <div className="border-t border-border pt-3 font-mono text-xs text-muted-foreground">
          Cancelled: 0.5 mUSDT per YES or NO
        </div>
      </CardContent>
    </Card>
  );
}
