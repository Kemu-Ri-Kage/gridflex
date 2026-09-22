import { FeedPanel } from '@/components/feed-panel';
import { Reveal } from '@/components/landing/scroll-motion';
import { SectionHeading } from '@/components/landing/section-heading';

export function FeedProof() {
  return (
    <section className="border-b border-border py-16 sm:py-24" id="feed">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <Reveal>
          <SectionHeading index="03" title="Proof" />
          <p className="mb-10 max-w-2xl text-lg leading-8 text-muted-foreground">
            Each reading is checked live against <span className="font-mono">GridOracle</span> in
            your browser.
          </p>
          <FeedPanel />
        </Reveal>
      </div>
    </section>
  );
}
