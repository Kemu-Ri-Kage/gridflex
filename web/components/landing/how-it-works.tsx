import { DataPathDiagram } from '@/components/landing/data-path-diagram';
import { Reveal } from '@/components/landing/scroll-motion';
import { SectionHeading } from '@/components/landing/section-heading';

export function HowItWorks() {
  return (
    <section className="border-b border-border py-16 sm:py-24" id="how-it-works">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <Reveal>
          <SectionHeading index="02" title="How it works" />
          <p className="mb-10 max-w-2xl text-lg leading-8 text-muted-foreground">
            Hover or tap a stage to see its evidence.
          </p>
          <DataPathDiagram />
        </Reveal>
      </div>
    </section>
  );
}
