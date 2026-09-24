import type { Metadata } from 'next';

import { BottomPanel } from '@/components/bottom-panel';
import { Footer } from '@/components/footer';
import { InstrumentBar } from '@/components/instrument-bar';
import { MarketChart } from '@/components/market-chart';
import { MarketPanel } from '@/components/market-panel';
import { MobileTradeBar } from '@/components/mobile-trade-bar';
import { OrderColumn } from '@/components/order-column';
import { TerminalHeader } from '@/components/site-header';
import { MarketsProvider } from '@/lib/markets';

export const metadata: Metadata = {
  title: 'Terminal — GRIDFLEX',
};

export default function TradePage() {
  return (
    <MarketsProvider>
      <main className="flex min-h-screen flex-col bg-background text-foreground">
        <TerminalHeader />
        <InstrumentBar />
        <div className="grid flex-1 gap-px bg-border lg:grid-cols-[220px_minmax(0,1fr)_380px]">
          <div className="bg-background p-3">
            <MarketPanel />
          </div>
          <div className="flex min-h-[420px] flex-col bg-background">
            <MarketChart />
          </div>
          <div className="bg-background p-3">
            <OrderColumn />
          </div>
        </div>
        <div className="border-t border-border bg-background">
          <BottomPanel />
        </div>
        <Footer variant="terminal" />
        <MobileTradeBar />
      </main>
    </MarketsProvider>
  );
}
