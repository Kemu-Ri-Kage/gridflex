import { FeedProof } from '@/components/landing/feed-proof';
import { Hero } from '@/components/landing/hero';
import { HowItWorks } from '@/components/landing/how-it-works';
import { OpenTerminal } from '@/components/landing/open-terminal';
import { Problem } from '@/components/landing/problem';
import { SmoothScroll } from '@/components/landing/scroll-motion';
import { LandingHeader } from '@/components/site-header';

export default function Home() {
  return (
    <SmoothScroll>
      <main className="min-h-screen bg-background text-foreground">
        <LandingHeader />
        <Hero />
        <Problem />
        <HowItWorks />
        <FeedProof />
        <OpenTerminal />
      </main>
    </SmoothScroll>
  );
}
