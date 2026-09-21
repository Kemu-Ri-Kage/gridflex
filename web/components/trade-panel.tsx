'use client';

import * as React from 'react';
import { ArrowUpRight, ExternalLink, Loader2 } from 'lucide-react';

import { useWeb3, type SwapQuote } from '@/components/web3-provider';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { xLayerTestnet } from '@/lib/contracts';
import { formatToken } from '@/lib/format';
import { parsePositiveTokenAmount } from '@/lib/trade';

type TradeSide = 'YES' | 'NO';

function validTokenAmount(value: string): boolean {
  try {
    parsePositiveTokenAmount(value);
    return true;
  } catch {
    return false;
  }
}

export function TradePanel() {
  const {
    account,
    configured,
    snapshot,
    pendingAction,
    error,
    lastTransaction,
    connect,
    mintCollateral,
    mintSet,
    quoteToward,
    swapToward,
    resolve,
    cancel,
    redeem,
  } = useWeb3();
  const [side, setSide] = React.useState<TradeSide>('YES');
  const [mintAmount, setMintAmount] = React.useState('100');
  const [tradeAmount, setTradeAmount] = React.useState('100');
  const [quoteState, setQuoteState] = React.useState<{
    key: string;
    quote?: SwapQuote;
    unavailable: boolean;
  }>({ key: '', unavailable: false });
  const quoteKey = `${side}:${tradeAmount}`;

  React.useEffect(() => {
    if (!configured || !validTokenAmount(tradeAmount)) {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void quoteToward(side, tradeAmount)
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
          if (!cancelled) {
            setQuoteState({ key: quoteKey, unavailable: true });
          }
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [configured, quoteKey, quoteToward, side, tradeAmount]);

  const validMintAmount = validTokenAmount(mintAmount);
  const validTradeAmount = validTokenAmount(tradeAmount);
  const quote = quoteState.key === quoteKey ? quoteState.quote : undefined;
  const quoteUnavailable =
    quoteState.key === quoteKey && quoteState.unavailable;
  const canMint = Boolean(
    account && configured && validMintAmount && !pendingAction,
  );
  const canSwap = Boolean(
    account && configured && validTradeAmount && quote && !pendingAction,
  );
  const yesPrice = Number(snapshot.priceE18) / 1e16;
  const noPrice = 100 - yesPrice;

  return (
    <Card className="sticky top-3 rounded-[2px] border border-border bg-card py-0 shadow-none ring-0">
      <CardHeader className="rounded-none border-b border-border px-3 py-3">
        <CardTitle className="text-sm font-semibold text-foreground">
          Order ticket
        </CardTitle>
        <CardDescription>
          Mint a complete set, then swap into the side you want.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-3 py-4">
        {!configured && (
          <div className="rounded-[2px] border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-5 text-warning">
            Demo preview — contract addresses will activate after the X Layer
            deployment.
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button
            aria-pressed={side === 'YES'}
            className="h-10 rounded-[2px] border-border bg-background font-mono text-up shadow-none hover:bg-muted aria-pressed:border-up aria-pressed:bg-up/10 aria-pressed:ring-0"
            onClick={() => setSide('YES')}
            variant="outline"
          >
            YES{' '}
            <span className="ml-auto font-mono">{yesPrice.toFixed(1)}¢</span>
          </Button>
          <Button
            aria-pressed={side === 'NO'}
            className="h-10 rounded-[2px] border-border bg-background font-mono text-down shadow-none hover:bg-muted aria-pressed:border-down aria-pressed:bg-down/10 aria-pressed:ring-0"
            onClick={() => setSide('NO')}
            variant="outline"
          >
            NO <span className="ml-auto font-mono">{noPrice.toFixed(1)}¢</span>
          </Button>
        </div>

        <div>
          <label
            className="mb-2 block text-xs text-muted-foreground"
            htmlFor="mint-amount"
          >
            Complete set amount
          </label>
          <div className="relative">
            <Input
              aria-invalid={!validMintAmount}
              className="h-10 rounded-[2px] border-border bg-background pr-20 font-mono text-base text-foreground shadow-none focus-visible:ring-1"
              id="mint-amount"
              inputMode="decimal"
              min="0"
              onChange={(event) => setMintAmount(event.target.value)}
              step="0.01"
              type="number"
              value={mintAmount}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground">
              mUSDT
            </span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-px rounded-[2px] border border-border bg-border text-xs">
          <div>
            <div className="bg-card px-2 py-2 text-muted-foreground">mUSDT</div>
            <div className="truncate bg-card px-2 pb-2 font-mono text-foreground">
              {formatToken(snapshot.collateralBalance)}
            </div>
          </div>
          <div>
            <div className="bg-card px-2 py-2 text-muted-foreground">YES</div>
            <div className="truncate bg-card px-2 pb-2 font-mono text-up">
              {formatToken(snapshot.yesBalance)}
            </div>
          </div>
          <div>
            <div className="bg-card px-2 py-2 text-muted-foreground">NO</div>
            <div className="truncate bg-card px-2 pb-2 font-mono text-down">
              {formatToken(snapshot.noBalance)}
            </div>
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
              className="rounded-[2px] shadow-none"
              disabled={!configured || Boolean(pendingAction)}
              onClick={() => void mintCollateral()}
              variant="outline"
            >
              Get 1,000 demo mUSDT
            </Button>
            <Button
              className="h-10 rounded-[2px] bg-primary text-primary-foreground shadow-none hover:bg-primary/85"
              disabled={!canMint}
              onClick={() => void mintSet(mintAmount)}
            >
              Mint YES + NO set
            </Button>

            <div className="mt-2">
              <label
                className="mb-2 block text-xs text-muted-foreground"
                htmlFor="trade-amount"
              >
                Trade input
              </label>
              <div className="relative">
                <Input
                  aria-invalid={!validTradeAmount}
                  className="h-10 rounded-[2px] border-border bg-background pr-20 font-mono text-base text-foreground shadow-none focus-visible:ring-1"
                  id="trade-amount"
                  inputMode="decimal"
                  min="0"
                  onChange={(event) => setTradeAmount(event.target.value)}
                  step="0.01"
                  type="number"
                  value={tradeAmount}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground">
                  {side === 'YES' ? 'NO' : 'YES'}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 rounded-[2px] border border-border bg-background p-3 text-xs">
              <div>
                <div className="text-muted-foreground">Estimated output</div>
                <div className="mt-1 font-mono text-foreground">
                  {quote ? `${formatToken(quote.amountOut)} ${side}` : '—'}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Minimum received</div>
                <div className="mt-1 font-mono text-foreground">
                  {quote
                    ? `${formatToken(quote.minimumAmountOut)} ${side}`
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

            <Button
              className="h-9 rounded-[2px] shadow-none"
              disabled={!canSwap}
              onClick={() => void swapToward(side, tradeAmount)}
              variant="secondary"
            >
              Swap towards {side}
            </Button>
            <div className="grid grid-cols-3 gap-2">
              <Button
                className="rounded-[2px] shadow-none"
                disabled={
                  !configured ||
                  Boolean(pendingAction) ||
                  snapshot.resolved ||
                  snapshot.cancelled
                }
                onClick={() => void resolve()}
                size="sm"
                variant="ghost"
              >
                Resolve
              </Button>
              <Button
                className="rounded-[2px] shadow-none"
                disabled={
                  !configured ||
                  Boolean(pendingAction) ||
                  snapshot.resolved ||
                  snapshot.cancelled
                }
                onClick={() => void cancel()}
                size="sm"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                className="rounded-[2px] shadow-none"
                disabled={
                  !configured ||
                  Boolean(pendingAction) ||
                  (!snapshot.resolved && !snapshot.cancelled)
                }
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
          {!pendingAction && error && (
            <span className="text-down">{error}</span>
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

        <div className="border-t border-border pt-4 text-xs leading-5 text-muted-foreground">
          Cash-settled demo market. No electricity, stock, or physical asset is
          delivered. Cancelled markets pay 0.5 mUSDT per YES or NO token.
        </div>
      </CardContent>
    </Card>
  );
}
