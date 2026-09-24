import type { Metadata } from 'next';

import { BottomPanel } from '@/components/bottom-panel';
import { Footer } from '@/components/footer';
import { InstrumentBar } from '@/components/instrument-bar';
import { MarketChart } from '@/components/market-chart';
import { MarketPanel } from '@/components/market-panel';
import { MobileTradeBar } from '@/components/mobile-trade-bar';
import { OrderColumn } from '@/components/order-column';
import { PortfolioProvider, WinningsBanner } from '@/components/portfolio';
import { TerminalHeader } from '@/components/site-header';
import { Rise } from '@/components/terminal-ui';
import { MarketsProvider } from '@/lib/markets';

export const metadata: Metadata = {
  title: 'Terminal — GRIDFLEX',
};

export default function TradePage() {
  return (
    <MarketsProvider>
      <PortfolioProvider>
        <main className="flex min-h-screen flex-col bg-background text-foreground">
          <TerminalHeader />
          {/* The terminal's regions rise into place once, on load, in
              reading order (design-brief.md §13). The header stays put;
              the winnings banner and the phone's trade bar appear on their
              own events, not on load. */}
          <Rise index={0}>
            <InstrumentBar />
          </Rise>
          <WinningsBanner />
          <div className="grid flex-1 gap-px bg-border lg:grid-cols-[264px_minmax(0,1fr)_384px]">
            <div className="bg-background p-3">
              <Rise index={1}>
                <MarketPanel />
              </Rise>
            </div>
            <div className="flex min-h-[420px] flex-col bg-background">
              <Rise className="flex flex-1 flex-col" index={2}>
                <MarketChart />
              </Rise>
            </div>
            <div className="bg-background p-3">
              <Rise index={3}>
                <OrderColumn />
              </Rise>
            </div>
          </div>
          <div className="border-t border-border bg-background">
            <Rise index={4}>
              <BottomPanel />
            </Rise>
          </div>
          <Footer variant="terminal" />
          <MobileTradeBar />
        </main>
      </PortfolioProvider>
    </MarketsProvider>
  );
}
