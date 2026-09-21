import { BottomPanel } from '@/components/bottom-panel';
import { CandlestickChart } from '@/components/candlestick-chart';
import { InstrumentBar } from '@/components/instrument-bar';
import { MarketPanel } from '@/components/market-panel';
import { TerminalHeader } from '@/components/site-header';
import { TradePanel } from '@/components/trade-panel';
import { FEATURED_MARKET } from '@/lib/market-copy';

export default function TradePage() {
  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <TerminalHeader />
      <InstrumentBar />
      <div className="grid flex-1 gap-px bg-border lg:grid-cols-[220px_minmax(0,1fr)_380px]">
        <div className="bg-background p-3">
          <MarketPanel />
        </div>
        <div className="flex min-h-[420px] flex-col bg-background">
          <CandlestickChart strikeDollars={FEATURED_MARKET.strikeDollars} />
        </div>
        <div className="bg-background p-3">
          <TradePanel />
        </div>
      </div>
      <div className="border-t border-border bg-background">
        <BottomPanel />
      </div>
    </main>
  );
}
