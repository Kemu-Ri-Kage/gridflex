import { SectionHeading } from '@/components/landing/section-heading';
import { DataPathDiagram } from '@/components/landing/data-path-diagram';

export function HowItWorks() {
  return (
    <section className="border-b border-border py-16 sm:py-24" id="how-it-works">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <SectionHeading index="02" title="How it works" />
        <p className="mb-10 max-w-2xl text-lg leading-8 text-muted-foreground">
          Four steps, one path from raw ERCOT data to a settled contract. Hover or tap a stage —
          each one shows the real evidence behind it, not a mockup.
        </p>
        <DataPathDiagram />
      </div>
    </section>
  );
}
