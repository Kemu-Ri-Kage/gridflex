import { Reveal } from '@/components/landing/scroll-motion';
import { SectionHeading } from '@/components/landing/section-heading';

export function Problem() {
  return (
    <section className="border-b border-border py-16 sm:py-24" id="problem">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <Reveal>
          <SectionHeading index="01" title="Problem" />
          <div className="mb-8 border border-border bg-card p-5 sm:mb-12">
            <div className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
              26 Jan 2026 · North Hub day-ahead average
            </div>
            <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-foreground sm:text-4xl">
              $694.03/MWh
            </div>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              {/* 25x: the 2026-01-26 ERCOT_HBNORTH_DA_AVG value ($694.03) over the median
                  of all 363 published North Hub days in data/metrics/ ($28.24) = 24.58. */}
              On 26 Jan 2026, North Hub averaged $694.03/MWh — about 25× a normal day.
            </p>
          </div>
          <div className="grid gap-8 lg:grid-cols-2">
            <p className="text-lg leading-8 text-muted-foreground">
              Most traders see ERCOT prices through a vendor or a dashboard, with no way to check
              what they were computed from.
            </p>
            <p className="text-lg leading-8 text-muted-foreground">
              GRIDFLEX publishes each reading onchain with a hash of its raw source files. Anyone
              can recompute the hash from the same public data.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
