'use client';

import * as React from 'react';
import Link from 'next/link';
import gsap from 'gsap';
import { SplitText } from 'gsap/SplitText';

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function Hero() {
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
          Power derivatives, settled against data you can verify yourself.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
          ERCOT power readings published onchain with a hash of their source; cash-settled
          contracts resolve against them.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link
            className="border border-foreground bg-foreground px-6 py-3 font-mono text-xs uppercase tracking-[0.12em] text-background transition-colors duration-200 hover:bg-transparent hover:text-foreground"
            href="/trade"
          >
            Open terminal
          </Link>
        </div>
      </div>
    </section>
  );
}
