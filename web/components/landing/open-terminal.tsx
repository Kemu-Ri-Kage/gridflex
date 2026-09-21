import Link from 'next/link';

import { SectionHeading } from '@/components/landing/section-heading';

export function OpenTerminal() {
  return (
    <section className="py-20 sm:py-28">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <SectionHeading index="04" title="Open terminal" />
        <div className="flex flex-col items-start justify-between gap-8 border border-border bg-card p-8 sm:flex-row sm:items-center sm:p-12">
          <p className="max-w-xl text-lg leading-8 text-muted-foreground">
            North Hub and West–North basis contracts, priced against the same verified readings
            shown above. Cash-settled in MockUSDT on X Layer testnet.
          </p>
          <Link
            className="shrink-0 border border-foreground bg-foreground px-8 py-4 font-mono text-sm uppercase tracking-[0.12em] text-background hover:bg-transparent hover:text-foreground"
            href="/trade"
          >
            Open terminal
          </Link>
        </div>
      </div>
    </section>
  );
}
