import { SectionHeading } from '@/components/landing/section-heading';
import { FeedPanel } from '@/components/feed-panel';

export function FeedProof() {
  return (
    <section className="border-b border-border py-16 sm:py-24" id="feed">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <SectionHeading index="03" title="The feed as proof" />
        <p className="mb-10 max-w-2xl text-lg leading-8 text-muted-foreground">
          Every reading below is a committed file plus a fresh onchain check, run live in your
          browser against <span className="font-mono">GridOracle</span> — not a screenshot.
        </p>
        <FeedPanel />
      </div>
    </section>
  );
}
