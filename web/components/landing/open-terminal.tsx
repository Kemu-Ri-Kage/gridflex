'use client';

import Link from 'next/link';

import { Reveal } from '@/components/landing/scroll-motion';
import { SectionHeading } from '@/components/landing/section-heading';
import { marketName, useMarkets } from '@/lib/markets';

export function OpenTerminal() {
  const { markets } = useMarkets();

  return (
    <section className="py-20 sm:py-28">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <Reveal>
          <SectionHeading index="04" title="Open terminal" />
          <div className="flex flex-col items-start justify-between gap-8 border border-border bg-card p-8 sm:flex-row sm:items-center sm:p-12">
            <p className="max-w-xl text-lg leading-8 text-muted-foreground">
              {markets === null
                ? 'Loading…'
                : markets.length === 0
                  ? 'No contracts listed yet.'
                  : `Listed: ${markets.map(marketName).join(', ')}.`}
            </p>
            <Link
              className="shrink-0 border border-foreground bg-foreground px-8 py-4 font-mono text-sm uppercase tracking-[0.12em] text-background transition-colors duration-200 hover:bg-transparent hover:text-foreground"
              href="/trade"
            >
              Open terminal
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
