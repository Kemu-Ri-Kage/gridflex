'use client';

import * as React from 'react';
import { ArrowUpRight, ExternalLink, Loader2 } from 'lucide-react';

import { BuyStepList } from '@/components/buy-step-list';
import { ConnectionHelp } from '@/components/connection-help';
import { PositionSummary } from '@/components/position-summary';
import { SwitchPosition } from '@/components/switch-position';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useWeb3,
  type BuyQuote,
  type TradeSide,
} from '@/components/web3-provider';
import { explorerTxUrl } from '@/lib/explorer';
import { formatToken } from '@/lib/format';
import { buySteps } from '@/lib/buy-steps';
import { marketName, strikeLabel, useMarkets } from '@/lib/markets';
import { orderGate, pendingOrderUnits } from '@/lib/pending-order';
import { oppositeBuyWarning, positionSummary } from '@/lib/position-summary';
import { ticketState } from '@/lib/ticket-state';
import { parsePositiveTokenAmount } from '@/lib/trade';
import { collateralShortfall } from '@/lib/transaction-outcome';

function tokenUnits(value: string): bigint | undefined {
  try {
    return parsePositiveTokenAmount(value);
  } catch {
    return undefined;
  }
}

function validTokenAmount(value: string): boolean {
  return tokenUnits(value) !== undefined;
}

/**
 * The order ticket for the selected market (design-brief.md §5: one
 * product, bought as YES or NO; labels and numbers only). Every number is
 * read from that market's contract through the Web3Provider, which the
 * order column points at the selection. Buy opens a position; Switch
 * position moves it between YES and NO. There is no sell: the contract has
 * no exit into mUSDT before settlement, so the position block names the
 * only exits and warns before a buy that would open the other side.
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
    connecting,
    walletRpcFailed,
    buyProgress,
    lastTransaction,
    failedTransaction,
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
  const [tab, setTab] = React.useState('buy');
  const [side, setSide] = React.useState<TradeSide>('YES');
  const [amount, setAmount] = React.useState('100');
  const [quoteState, setQuoteState] = React.useState<{
    key: string;
    quote?: BuyQuote;
    unavailable: boolean;
  }>({ key: '', unavailable: false });

  const ticket = ticketState(snapshot, market, Math.floor(now / 1000));
  const { ready, settled, closed, cancellable, tradingOpen } = ticket;
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
  const units = tokenUnits(amount);
  // Checked again in buy(); here it keeps a mint the balance can't cover
  // from being offered at all.
  const shortfall =
    account && ready && units !== undefined
      ? collateralShortfall(units, snapshot.collateralBalance)
      : undefined;
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
    account &&
      tradingOpen &&
      validAmount &&
      !shortfall &&
      quote &&
      !busy &&
      !gate.blocked,
  );
  const selectedMarket = markets?.find(
    (m) => m.address.toLowerCase() === (market ?? '').toLowerCase(),
  );
  // What the wallet holds here, netted into pairs and a side; buying the
  // other side adds pairs, it never closes the position.
  const position =
    account && ready && !settled
      ? positionSummary(snapshot.yesBalance, snapshot.noBalance)
      : undefined;
  const oppositeWarning = oppositeBuyWarning(position, side);
  const steps =
    buyProgress?.steps ??
    (units !== undefined ? buySteps(side, units, quote?.swapOut) : undefined);
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
        {/* First in the ticket: until the wallet's RPC answers, nothing
            below can be sent. */}
        {walletRpcFailed && <ConnectionHelp />}

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

        {position && selectedMarket && (
          <PositionSummary
            onSwitch={() => setTab('switch')}
            strike={strikeLabel(selectedMarket)}
            summary={position}
            tradingOpen={tradingOpen}
          />
        )}

        <Tabs onValueChange={(value) => setTab(String(value))} value={tab}>
          <TabsList
            className="w-full justify-start rounded-none border-b border-border bg-transparent px-0"
            variant="line"
          >
            <TabsTrigger value="buy">Buy</TabsTrigger>
            <TabsTrigger value="switch">Switch position</TabsTrigger>
          </TabsList>
          <TabsContent className="space-y-4 pt-2" value="buy">
            <div className="grid grid-cols-1 gap-2 min-[440px]:grid-cols-2">
              <Button
                aria-pressed={side === 'YES'}
                className="h-auto min-h-10 rounded-[2px] border-border bg-background py-1.5 font-mono text-up shadow-none hover:bg-muted aria-pressed:border-up aria-pressed:bg-up/10 aria-pressed:ring-0"
                onClick={() => setSide('YES')}
                variant="outline"
              >
                YES
                <span className="ml-auto flex flex-col items-end font-mono leading-tight tabular-nums">
                  {ready ? (
                    <>
                      <span className="text-sm">{yesPrice.toFixed(1)}¢</span>
                      <span className="text-[11px] text-muted-foreground">{Math.round(yesPrice)}% implied</span>
                    </>
                  ) : (
                    '—'
                  )}
                </span>
              </Button>
              <Button
                aria-pressed={side === 'NO'}
                className="h-auto min-h-10 rounded-[2px] border-border bg-background py-1.5 font-mono text-down shadow-none hover:bg-muted aria-pressed:border-down aria-pressed:bg-down/10 aria-pressed:ring-0"
                onClick={() => setSide('NO')}
                variant="outline"
              >
                NO
                <span className="ml-auto flex flex-col items-end font-mono leading-tight tabular-nums">
                  {ready ? (
                    <>
                      <span className="text-sm">{noPrice.toFixed(1)}¢</span>
                      <span className="text-[11px] text-muted-foreground">{Math.round(noPrice)}% implied</span>
                    </>
                  ) : (
                    '—'
                  )}
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
              {tradingOpen && shortfall && (
                <p className="mt-2 text-xs leading-5 text-warning">
                  {shortfall}{' '}
                  <button
                    className="font-semibold text-foreground underline underline-offset-4 disabled:opacity-50"
                    disabled={!configured || busy}
                    onClick={() => void mintCollateral()}
                    type="button"
                  >
                    Get 1,000 demo mUSDT
                  </button>
                </p>
              )}
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
                  {quote
                    ? `${formatToken(quote.minimumTotalOut)} ${side}`
                    : '—'}
                </div>
              </div>
              <div className="col-span-2 text-muted-foreground">
                0.50% slippage protection · 5-minute deadline
                {quoteUnavailable && (
                  <span className="ml-2 text-warning">
                    Live quote unavailable.
                  </span>
                )}
              </div>
            </div>

            {account && tradingOpen && steps && (
              <BuyStepList progress={buyProgress} steps={steps} />
            )}

            {account && tradingOpen && oppositeWarning && !buyProgress && (
              <p className="text-xs leading-5 text-warning">
                {oppositeWarning}{' '}
                <button
                  className="font-semibold text-foreground underline underline-offset-4"
                  onClick={() => setTab('switch')}
                  type="button"
                >
                  Switch to change sides
                </button>
              </p>
            )}

            {account && (
              <Button
                className={
                  'h-10 w-full rounded-[2px] shadow-none ' +
                  (side === 'YES'
                    ? 'bg-up text-background hover:bg-up/85'
                    : 'bg-down text-background hover:bg-down/85')
                }
                disabled={!canBuy}
                onClick={() => void buy(side, amount)}
              >
                {ready && !tradingOpen ? 'Trading closed' : `Buy ${side}`}
              </Button>
            )}
          </TabsContent>
          <TabsContent className="pt-2" value="switch">
            {/* Keyed by market so a half-typed switch never carries over. */}
            <SwitchPosition
              blocked={gate.blocked}
              key={market}
              state={ticket}
            />
          </TabsContent>
        </Tabs>

        {!account ? (
          <Button
            className="h-10 w-full rounded-[2px] bg-primary text-primary-foreground shadow-none hover:bg-primary/85"
            disabled={connecting}
            onClick={() => void connect()}
          >
            {connecting ? 'Check your wallet…' : 'Connect wallet to trade'}{' '}
            <ArrowUpRight data-icon="inline-end" />
          </Button>
        ) : (
          <div className="grid gap-2">
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
              <span className="text-down">
                {error ?? connectError}
                {error && failedTransaction && (
                  <a
                    className="ml-1.5 inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
                    href={explorerTxUrl(failedTransaction)}
                    rel="noreferrer"
                    target="_blank"
                  >
                    View on OKLink <ExternalLink className="size-3" />
                  </a>
                )}
              </span>
            )}
          {!pendingAction && !error && lastTransaction && (
            <a
              className="inline-flex items-center gap-1.5 text-foreground underline-offset-4 hover:underline"
              href={explorerTxUrl(lastTransaction)}
              rel="noreferrer"
              target="_blank"
            >
              Transaction confirmed <ExternalLink className="size-3" />
            </a>
          )}
        </div>

        {/* The cancellation payout is stated as fact only once cancel() has
            run; before settlement it is conditional, and after resolution
            it no longer applies. */}
        {ready && !snapshot.resolved && (
          <div className="border-t border-border pt-3 font-mono text-xs text-muted-foreground">
            {snapshot.cancelled
              ? 'Cancelled · 0.5 mUSDT per YES or NO'
              : 'If cancelled: 0.5 mUSDT per YES or NO'}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
