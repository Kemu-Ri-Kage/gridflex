'use client';

import Link from 'next/link';

import { Reveal } from '@/components/landing/scroll-motion';
import { SectionHeading } from '@/components/landing/section-heading';
import { ContractCards } from '@/components/landing/contract-cards';
import { useMarkets } from '@/lib/markets';

export function OpenTerminal() {
  const { markets, now } = useMarkets();

  return (
    <section className="py-20 sm:py-28">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <Reveal>
          <SectionHeading index="04" title="Open terminal" />
          {markets && markets.length > 0 ? (
            // Every listed question, each named and priced from its own
            // contract (design-brief.md §6), one click into the terminal.
            <ContractCards markets={markets} now={now} />
          ) : (
            <p className="text-lg leading-8 text-muted-foreground">
              {markets === null ? 'Loading…' : 'No contracts listed yet.'}
            </p>
          )}
          <div className="mt-10 flex flex-wrap items-center justify-between gap-6">
            <p className="max-w-xl text-lg leading-8 text-muted-foreground">
              Buy YES or NO at any size, switch sides before trading closes, and redeem at settlement, on X Layer testnet.
            </p>
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
