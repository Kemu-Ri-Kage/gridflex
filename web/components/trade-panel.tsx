'use client';

import * as React from 'react';
import { ArrowUpRight, ExternalLink, Loader2, ShieldCheck } from 'lucide-react';

import { useWeb3 } from '@/components/web3-provider';
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

type TradeSide = 'YES' | 'NO';

type ModelContext = {
  registerTool: (
    tool: {
      name: string;
      title?: string;
      description: string;
      inputSchema: object;
      annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
      execute: (input: unknown) => unknown;
    },
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>;
};

declare global {
  interface Document {
    readonly modelContext?: ModelContext;
  }
}

function readTradeInput(input: unknown): { side: TradeSide; amount: string } {
  if (!input || typeof input !== 'object')
    throw new Error('Trade input must be an object.');
  const record = input as Record<string, unknown>;
  if (record.side !== 'YES' && record.side !== 'NO')
    throw new Error('side must be YES or NO.');
  if (
    typeof record.amount !== 'number' ||
    !Number.isFinite(record.amount) ||
    record.amount <= 0
  ) {
    throw new Error('amount must be a positive number.');
  }
  return { side: record.side, amount: String(record.amount) };
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
    swapToward,
    resolve,
    cancel,
    redeem,
  } = useWeb3();
  const [side, setSide] = React.useState<TradeSide>('YES');
  const [amount, setAmount] = React.useState('100');

  React.useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();

    void Promise.resolve(
      context.registerTool(
        {
          name: 'stage_gridflex_trade',
          title: 'Stage GRIDFLEX trade',
          description:
            'Select the YES or NO side and enter a positive mUSDT amount in the visible GRIDFLEX trade panel. This does not send a blockchain transaction.',
          inputSchema: {
            type: 'object',
            properties: {
              side: { type: 'string', enum: ['YES', 'NO'] },
              amount: { type: 'number', exclusiveMinimum: 0 },
            },
            required: ['side', 'amount'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute(input) {
            const next = readTradeInput(input);
            setSide(next.side);
            setAmount(next.amount);
            return {
              staged: true,
              side: next.side,
              amount: next.amount,
              unit: 'mUSDT',
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);

    return () => lifecycle.abort();
  }, []);

  const parsedAmount = Number(amount);
  const validAmount = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const canTransact = Boolean(
    account && configured && validAmount && !pendingAction,
  );
  const yesPrice = Number(snapshot.priceE18) / 1e16;
  const noPrice = 100 - yesPrice;

  return (
    <Card className="sticky top-6 border-white/10 bg-[#0c1413] shadow-[0_24px_80px_rgba(0,0,0,.3)] ring-0">
      <CardHeader className="border-b border-white/8 pb-4">
        <CardTitle className="text-lg text-white">Take a position</CardTitle>
        <CardDescription>
          Mint a complete set, then swap into the side you want.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        {!configured && (
          <div className="rounded-lg border border-amber-300/15 bg-amber-300/8 px-3 py-2 text-xs leading-5 text-amber-100/80">
            Demo preview — contract addresses will activate after the X Layer
            deployment.
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button
            aria-pressed={side === 'YES'}
            className="h-12 border-[#a8ff3e]/40 bg-[#a8ff3e]/10 text-[#baff68] hover:bg-[#a8ff3e]/15 aria-pressed:ring-2 aria-pressed:ring-[#a8ff3e]/60"
            onClick={() => setSide('YES')}
            variant="outline"
          >
            YES{' '}
            <span className="ml-auto font-mono">{yesPrice.toFixed(1)}¢</span>
          </Button>
          <Button
            aria-pressed={side === 'NO'}
            className="h-12 border-orange-300/25 bg-orange-300/8 text-orange-200 hover:bg-orange-300/12 aria-pressed:ring-2 aria-pressed:ring-orange-300/50"
            onClick={() => setSide('NO')}
            variant="outline"
          >
            NO <span className="ml-auto font-mono">{noPrice.toFixed(1)}¢</span>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          YES {yesPrice.toFixed(1)}¢ — the market prices a {Math.round(yesPrice)}% chance.
        </p>

        <div>
          <label className="mb-2 block text-sm text-slate-400" htmlFor="amount">
            Amount
          </label>
          <div className="relative">
            <Input
              aria-invalid={!validAmount}
              className="h-12 border-white/10 bg-[#070b0b] pr-20 font-mono text-lg text-white"
              id="amount"
              inputMode="decimal"
              min="0"
              onChange={(event) => setAmount(event.target.value)}
              step="0.01"
              type="number"
              value={amount}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-slate-500">
              mUSDT
            </span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 rounded-lg border border-white/8 bg-black/15 p-3 text-center text-xs">
          <div>
            <div className="text-slate-500">mUSDT</div>
            <div className="mt-1 truncate font-mono text-slate-200">
              {formatToken(snapshot.collateralBalance)}
            </div>
          </div>
          <div>
            <div className="text-slate-500">YES</div>
            <div className="mt-1 truncate font-mono text-[#baff68]">
              {formatToken(snapshot.yesBalance)}
            </div>
          </div>
          <div>
            <div className="text-slate-500">NO</div>
            <div className="mt-1 truncate font-mono text-orange-200">
              {formatToken(snapshot.noBalance)}
            </div>
          </div>
        </div>

        {!account ? (
          <Button
            className="h-11 w-full bg-[#a8ff3e] text-[#061008] hover:bg-[#bdff6c]"
            onClick={() => void connect()}
          >
            Connect wallet to trade <ArrowUpRight data-icon="inline-end" />
          </Button>
        ) : (
          <div className="grid gap-2">
            <Button
              disabled={!configured || Boolean(pendingAction)}
              onClick={() => void mintCollateral()}
              variant="outline"
            >
              Get 1,000 demo mUSDT
            </Button>
            <Button
              className="h-10 bg-[#a8ff3e] text-[#061008] hover:bg-[#bdff6c]"
              disabled={!canTransact}
              onClick={() => void mintSet(amount)}
            >
              Mint YES + NO set
            </Button>
            <Button
              disabled={!canTransact}
              onClick={() => void swapToward(side, amount)}
              variant="secondary"
            >
              Swap toward {side}
            </Button>
            <div className="grid grid-cols-3 gap-2">
              <Button
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
            <span className="flex items-center gap-2 text-cyan-200">
              <Loader2 className="size-3.5 animate-spin" /> {pendingAction}…
            </span>
          )}
          {!pendingAction && error && (
            <span className="text-red-300">{error}</span>
          )}
          {!pendingAction && !error && lastTransaction && (
            <a
              className="inline-flex items-center gap-1.5 text-cyan-300 hover:text-cyan-200"
              href={`${xLayerTestnet.blockExplorers.default.url}/tx/${lastTransaction}`}
              rel="noreferrer"
              target="_blank"
            >
              Transaction confirmed <ExternalLink className="size-3" />
            </a>
          )}
        </div>

        <div className="flex items-start gap-2.5 border-t border-white/8 pt-4 text-xs leading-5 text-slate-500">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-cyan-300" />
          Cash-settled demo market. No electricity, stock, or physical asset is
          delivered. Cancelled markets pay 0.5 mUSDT per YES or NO token.
        </div>
      </CardContent>
    </Card>
  );
}
