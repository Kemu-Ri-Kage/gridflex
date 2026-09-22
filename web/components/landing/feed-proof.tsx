import { FeedPanel } from '@/components/feed-panel';
import { Reveal } from '@/components/landing/scroll-motion';
import { SectionHeading } from '@/components/landing/section-heading';

export function FeedProof() {
  return (
    <section className="border-b border-border py-16 sm:py-24" id="proof">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <Reveal>
          <SectionHeading index="03" title="Proof" />
          <p className="mb-10 max-w-2xl text-lg leading-8 text-muted-foreground">
            Each price below is checked live against the oracle in your browser.
          </p>
          <FeedPanel />
        </Reveal>
      </div>
    </section>
  );
}
