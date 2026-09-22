'use client';

import * as React from 'react';
import Link from 'next/link';
import gsap from 'gsap';
import { SplitText } from 'gsap/SplitText';

import { formatPrice } from '@/lib/format';
import { dayLabel } from '@/lib/markets';
import { hourLabel, priceSummary } from '@/lib/price-summary';

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A price inside the headline, in the mono number face (checklist #5). */
function Price({ cents }: { cents: number }) {
  return <span className="font-mono tabular-nums">{formatPrice(cents)}</span>;
}

/**
 * Opens with the daily swing (design-brief.md §7): the latest published
 * day's cheapest and dearest hour, from build_feed_data.py's price summary.
 */
export function Hero() {
  const { dayKey, cheapest, dearest } = priceSummary.latestDay;
  const headlineRef = React.useRef<HTMLHeadingElement | null>(null);

  // Word-by-word entrance on first load only - not scroll-triggered, so it
  // never replays on scroll-back or resize (design-brief.md §13). Skipped
  // entirely under prefers-reduced-motion: the headline just renders as
  // plain static text, already in its final state.
  React.useLayoutEffect(() => {
    const el = headlineRef.current;
    if (!el || prefersReducedMotion()) return;

    gsap.registerPlugin(SplitText);
    const split = new SplitText(el, { type: 'words' });
    gsap.set(split.words, { opacity: 0, y: 14 });
    gsap.to(split.words, {
      opacity: 1,
      y: 0,
      duration: 0.5,
      stagger: 0.04,
      ease: 'power2.out',
    });

    return () => split.revert();
  }, []);

  return (
    <section className="border-b border-border py-20 sm:py-28 lg:py-36">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <p className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
          X Layer testnet · MockUSDT
        </p>
        <h1
          className="mt-6 max-w-4xl text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl"
          ref={headlineRef}
        >
          Texas power cost <Price cents={cheapest.value} /> at {hourLabel(cheapest.hourStartCentral)}{' '}
          and <Price cents={dearest.value} /> at {hourLabel(dearest.hourStartCentral)}.
        </h1>
        <p className="mt-4 font-mono text-xs tabular-nums text-muted-foreground">
          {dayLabel(dayKey, true)} · cheapest and dearest hour, Central time · $/MWh
        </p>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
          Trade YES or NO on whether Texas power will cost more than the strike on a given day.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link
            className="border border-foreground bg-foreground px-6 py-3 font-mono text-xs uppercase tracking-[0.12em] text-background transition-opacity duration-200 hover:opacity-80 active:opacity-60"
            href="/trade"
          >
            Open terminal
          </Link>
        </div>
      </div>
    </section>
  );
}
