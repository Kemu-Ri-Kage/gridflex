import { DataPathDiagram } from '@/components/landing/data-path-diagram';
import { Reveal } from '@/components/landing/scroll-motion';
import { SectionHeading } from '@/components/landing/section-heading';

/** The one section where ERCOT is named (design-brief.md §5). */
export function HowWeVerify() {
  return (
    <section className="border-b border-border py-16 sm:py-24" id="how-we-verify">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <Reveal>
          <SectionHeading index="02" title="How we verify" />
          <p className="mb-10 max-w-2xl text-lg leading-8 text-muted-foreground">
            Each day&apos;s price comes from ERCOT, Texas&apos;s official grid price, and is
            published onchain with a hash of its source files.
          </p>
          <DataPathDiagram />
        </Reveal>
      </div>
    </section>
  );
}
