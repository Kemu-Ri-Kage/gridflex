import { Footer } from '@/components/footer';
import { FeedProof } from '@/components/landing/feed-proof';
import { Hero } from '@/components/landing/hero';
import { HowWeVerify } from '@/components/landing/how-we-verify';
import { OpenTerminal } from '@/components/landing/open-terminal';
import { PriceRange } from '@/components/landing/price-range';
import { SmoothScroll } from '@/components/landing/scroll-motion';
import { LandingHeader } from '@/components/site-header';
import { MarketsProvider } from '@/lib/markets';

export default function Home() {
  return (
    <SmoothScroll>
      <MarketsProvider>
        <main className="min-h-screen bg-background text-foreground">
          <LandingHeader />
          <Hero />
          <PriceRange />
          <HowWeVerify />
          <FeedProof />
          <OpenTerminal />
          <Footer variant="landing" />
        </main>
      </MarketsProvider>
    </SmoothScroll>
  );
}
