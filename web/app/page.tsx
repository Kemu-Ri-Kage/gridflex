import { Bolt } from 'lucide-react';

import { FeedPanel } from '@/components/feed-panel';
import { MarketProbability, ReserveStat } from '@/components/market-live-data';
import { TradePanel } from '@/components/trade-panel';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { WalletButton } from '@/components/wallet-button';

export default function Home() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-2.5">
              <span className="grid size-7 place-items-center border border-border bg-foreground text-background">
                <Bolt className="size-3.5" fill="currentColor" />
              </span>
              <span className="font-mono text-sm font-bold tracking-[-0.04em]">
                GRIDFLEX
              </span>
            </div>
            <nav
              aria-label="Primary"
              className="hidden items-center gap-1 md:flex"
            >
              <a
                className="px-3 py-2 text-sm text-foreground hover:bg-accent"
                href="#market"
              >
                Market
              </a>
              <a
                className="px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                href="#feed"
              >
                Feed
              </a>
              <a
                className="px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                href="#trade"
              >
                Trade
              </a>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <Badge className="hidden gap-1.5 sm:inline-flex" variant="outline">
              <span className="size-1.5 rounded-full bg-up" />
              X Layer testnet
            </Badge>
            <WalletButton />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <section
          className="mb-6 flex scroll-mt-6 flex-col justify-between gap-3 border-b border-border pb-5 sm:flex-row sm:items-end"
          id="market"
        >
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
              Contract
            </div>
            <div className="mt-1 font-mono text-lg font-semibold tracking-tight sm:text-xl">
              ERCOT-HBNORTH-DA-AVG &gt; $30.00 · SETTLES 2026-09-08
            </div>
          </div>
          <div className="font-mono text-xs tabular-nums text-muted-foreground">
            Oracle dayKey 20260908 · actual $39.57
          </div>
        </section>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-5">
            <Card>
              <CardHeader className="border-b border-border pb-4 sm:grid-cols-[1fr_auto]">
                <div>
                  <CardDescription className="font-mono text-xs uppercase tracking-[0.14em]">
                    Implied probability
                  </CardDescription>
                  <CardTitle className="mt-1 !font-mono text-2xl font-semibold tracking-tight tabular-nums text-foreground">
                    <MarketProbability />
                  </CardTitle>
                </div>
                <div className="mt-3 flex gap-5 sm:mt-0 sm:text-right">
                  <div>
                    <div className="text-xs text-muted-foreground">YES liquidity</div>
                    <div className="mt-1 font-mono text-sm tabular-nums text-foreground">
                      <ReserveStat side="YES" />
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">NO liquidity</div>
                    <div className="mt-1 font-mono text-sm tabular-nums text-foreground">
                      <ReserveStat side="NO" />
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-4">
                <div className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4">
                  {[
                    ['Metric', 'North Hub DA'],
                    ['Threshold', '$30.00'],
                    ['Settlement', 'Strictly above'],
                    ['Collateral', 'Mock USDT'],
                  ].map(([label, value]) => (
                    <div className="bg-card px-3 py-2.5" key={label}>
                      <div className="text-xs text-muted-foreground">{label}</div>
                      <div className="mt-1 font-mono text-sm font-medium tabular-nums text-foreground">
                        {value}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <div className="scroll-mt-6" id="feed">
              <FeedPanel />
            </div>
          </div>

          <aside className="scroll-mt-6" id="trade">
            <TradePanel />
          </aside>
        </div>
      </div>
    </main>
  );
}
