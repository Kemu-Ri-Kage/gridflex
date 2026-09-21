import { SectionHeading } from '@/components/landing/section-heading';

export function Problem() {
  return (
    <section className="border-b border-border py-16 sm:py-24" id="problem">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <SectionHeading index="01" title="Problem" />
        <div className="grid gap-8 lg:grid-cols-2">
          <p className="text-lg leading-8 text-muted-foreground">
            ERCOT&rsquo;s own market data is public, but by the time it reaches a trader it has passed
            through a vendor, a spreadsheet, or a dashboard with no way to check what the number
            was actually computed from. A settlement figure and a marketing chart look identical —
            there is no way to tell which one you are looking at.
          </p>
          <p className="text-lg leading-8 text-muted-foreground">
            GRIDFLEX publishes the reading and a hash of the exact raw files it was computed from,
            onchain, before anything settles against it. Anyone can re-derive the hash from the
            same public data and check it matches. If it does not match, that is shown as a
            mismatch — not smoothed over as a temporary glitch.
          </p>
        </div>
      </div>
    </section>
  );
}
