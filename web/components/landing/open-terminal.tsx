'use client';

import Link from 'next/link';

import { Reveal } from '@/components/landing/scroll-motion';
import { SectionHeading } from '@/components/landing/section-heading';
import { marketName, statusLabel, useMarkets } from '@/lib/markets';

export function OpenTerminal() {
  const { markets, now } = useMarkets();

  return (
    <section className="py-20 sm:py-28">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <Reveal>
          <SectionHeading index="04" title="Open terminal" />
          <div className="flex flex-col items-start justify-between gap-8 border border-border bg-card p-8 sm:flex-row sm:items-center sm:p-12">
            {markets && markets.length > 0 ? (
              // One question per row, each with its own contract status
              // (design-brief.md §6) - a list, not a run-on sentence.
              <div className="w-full max-w-xl">
                <div className="mb-3 font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Listed
                </div>
                <ul className="divide-y divide-border border-y border-border">
                  {markets.map((market) => (
                    <li
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3"
                      key={market.address}
                    >
                      <span className="text-base text-foreground">{marketName(market)}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {statusLabel(market, now) ?? '…'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="max-w-xl text-lg leading-8 text-muted-foreground">
                {markets === null ? 'Loading…' : 'No contracts listed yet.'}
              </p>
            )}
            <Link
              className="shrink-0 border border-foreground bg-foreground px-8 py-4 font-mono text-sm uppercase tracking-[0.12em] text-background transition-opacity duration-200 hover:opacity-80 active:opacity-60"
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
