import { Activity, Bolt, Clock3 } from 'lucide-react';

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
    <div className="relative h-40 overflow-hidden rounded-xl border border-white/8 bg-[#09100f]">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,.035)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,.035)_1px,transparent_1px)] bg-[size:48px_36px]" />
      <svg
        className="relative h-full w-full"
        preserveAspectRatio="none"
        viewBox={`0 0 ${width} ${height}`}
      >
        <title>Seven day North Hub price trend</title>
        <defs>
          <linearGradient id="price-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#a8ff3e" stopOpacity="0.28" />
            <stop offset="1" stopColor="#a8ff3e" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon fill="url(#price-fill)" points={`0,156 ${points} 640,156`} />
        <polyline
          fill="none"
          points={points}
          stroke="#a8ff3e"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="3"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className="absolute bottom-3 left-4 font-mono text-xs text-slate-500">
        7D
      </span>
      <span className="absolute right-4 top-3 font-mono text-xs text-[#a8ff3e]">
        $45.18
      </span>
    </div>
  );
}

export default function Home() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-white/8 bg-[#070b0b]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-2.5">
              <span className="grid size-8 place-items-center rounded-lg bg-[#a8ff3e] text-[#061008] shadow-[0_0_28px_rgba(168,255,62,.2)]">
                <Bolt className="size-4" fill="currentColor" />
              </span>
              <span className="font-mono text-lg font-bold tracking-[-0.04em]">
                GRIDFLEX
              </span>
            </div>
            <nav
              aria-label="Primary"
              className="hidden items-center gap-1 md:flex"
            >
              <a
                className="rounded-md px-3 py-2 text-sm text-white hover:bg-white/5"
                href="#market"
              >
                Market
              </a>
              <a
                className="rounded-md px-3 py-2 text-sm text-slate-400 hover:bg-white/5 hover:text-white"
                href="#feed"
              >
                Feed
              </a>
              <a
                className="rounded-md px-3 py-2 text-sm text-slate-400 hover:bg-white/5 hover:text-white"
                href="#trade"
              >
                Trade
              </a>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <Badge
              className="hidden border-cyan-300/15 bg-cyan-300/8 text-cyan-200 sm:inline-flex"
              variant="outline"
            >
              <span className="size-1.5 rounded-full bg-cyan-300" />
              X Layer testnet
            </Badge>
            <WalletButton />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <section
          className="mb-6 flex scroll-mt-6 flex-col justify-between gap-4 sm:flex-row sm:items-end"
          id="market"
        >
          <div>
            <div className="mb-2 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.16em] text-[#a8ff3e]">
              <Activity className="size-3.5" /> Live market
            </div>
            <h1 className="max-w-3xl text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">
              Did ERCOT North Hub day-ahead average exceed $30/MWh on 8 Sep
              2026?
            </h1>
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Clock3 className="size-4" />
            Oracle dayKey 20260908 · actual $39.57
          </div>
        </section>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-5">
            <Card className="border-white/8 bg-card/80 shadow-[0_24px_80px_rgba(0,0,0,.2)] ring-0">
              <CardHeader className="border-b border-white/8 pb-4 sm:grid-cols-[1fr_auto]">
                <div>
                  <CardDescription className="font-mono text-xs uppercase tracking-[0.14em] text-slate-500">
                    Implied probability
                  </CardDescription>
                  <CardTitle className="mt-1 text-4xl font-semibold tracking-[-0.05em] text-white">
                    <MarketProbability />
                  </CardTitle>
                </div>
                <div className="mt-3 flex gap-5 sm:mt-0 sm:text-right">
                  <div>
                    <div className="text-xs text-slate-500">YES liquidity</div>
                    <div className="mt-1 font-mono text-sm text-white">
                      <ReserveStat side="YES" />
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">NO liquidity</div>
                    <div className="mt-1 font-mono text-sm text-white">
                      <ReserveStat side="NO" />
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-4">
                <PriceChart />
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    ['Metric', 'North Hub DA'],
                    ['Threshold', '$30.00'],
                    ['Settlement', 'Strictly above'],
                    ['Collateral', 'Mock USDT'],
                  ].map(([label, value]) => (
                    <div
                      className="rounded-lg bg-white/[.035] px-3 py-2.5"
                      key={label}
                    >
                      <div className="text-xs text-slate-500">{label}</div>
                      <div className="mt-1 text-sm font-medium text-slate-200">
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
