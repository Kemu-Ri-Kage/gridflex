import { BottomPanel } from '@/components/bottom-panel';
import { CandlestickChart } from '@/components/candlestick-chart';
import { Footer } from '@/components/footer';
import { InstrumentBar } from '@/components/instrument-bar';
import { MarketPanel } from '@/components/market-panel';
import { SettlementPanel } from '@/components/settlement-panel';
import { TerminalHeader } from '@/components/site-header';
import { TradePanel } from '@/components/trade-panel';
import { FEATURED_MARKET, isPastSettlement } from '@/lib/market-copy';

export default function TradePage() {
  // Honest-reading rule (design-brief.md §6): once a market's settlement
  // date has passed, an active order ticket implies a trade is still live
  // when it isn't. The settlement summary (the real oracle reading, stated
  // as a reading - never as a market outcome, since no BinaryMarket is
  // deployed to actually resolve one) replaces it instead.
  const past = isPastSettlement();

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
          {past ? <SettlementPanel /> : <TradePanel />}
        </div>
      </div>
      <div className="border-t border-border bg-background">
        <BottomPanel />
      </div>
      <Footer variant="terminal" />
    </main>
  );
}
