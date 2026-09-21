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

const sparkline = [22, 29, 27, 35, 31, 42, 39, 48, 44, 51, 47, 56];

function PriceChart() {
  const width = 640;
  const height = 156;
  const min = Math.min(...sparkline);
  const max = Math.max(...sparkline);
  const points = sparkline
    .map((value, index) => {
      const x = (index / (sparkline.length - 1)) * width;
      const y = height - ((value - min) / (max - min)) * (height - 24) - 12;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <div className="relative h-40 overflow-hidden border border-border bg-muted">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,.035)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,.035)_1px,transparent_1px)] bg-[size:48px_36px]" />
      <svg
        className="relative h-full w-full"
        preserveAspectRatio="none"
        viewBox={`0 0 ${width} ${height}`}
      >
        <title>Seven day North Hub price trend</title>
        <defs>
          <linearGradient id="price-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--chart-1)" stopOpacity="0.22" />
            <stop offset="1" stopColor="var(--chart-1)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon fill="url(#price-fill)" points={`0,156 ${points} 640,156`} />
        <polyline
          fill="none"
          points={points}
          stroke="var(--chart-1)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className="absolute bottom-3 left-4 font-mono text-xs text-muted-foreground">
        7D
      </span>
      <span className="absolute right-4 top-3 font-mono text-xs tabular-nums text-chart-1">
        $45.18
      </span>
    </div>
  );
}

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
                <PriceChart />
                <div className="mt-4 grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4">
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
