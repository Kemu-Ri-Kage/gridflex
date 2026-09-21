'use client';

import * as React from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';

let scrollTriggerRegistered = false;

function registerScrollTrigger() {
  if (scrollTriggerRegistered) return;
  gsap.registerPlugin(ScrollTrigger);
  scrollTriggerRegistered = true;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Landing-page-only smooth momentum scroll (Lenis). Never mounted on
 * /trade — see design-brief.md §13/§14. Skips entirely under
 * prefers-reduced-motion, per §13's "with it set, ... the page scrolls
 * natively, with no exception."
 */
export function SmoothScroll({ children }: { children: React.ReactNode }) {
  React.useEffect(() => {
    if (prefersReducedMotion()) return;

    registerScrollTrigger();
    const lenis = new Lenis({ autoRaf: false });
    lenis.on('scroll', () => ScrollTrigger.update());

    let rafId: number;
    const raf = (time: number) => {
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    };
    rafId = requestAnimationFrame(raf);

    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const stop = () => {
      if (mq.matches) {
        cancelAnimationFrame(rafId);
        lenis.destroy();
      }
    };
    mq.addEventListener('change', stop);

    return () => {
      mq.removeEventListener('change', stop);
      cancelAnimationFrame(rafId);
      lenis.destroy();
    };
  }, []);

  return <>{children}</>;
}

/**
 * Scroll-triggered reveal, animating only `transform`/`opacity` per §13 and
 * checklist item 25 — no other property is ever touched here. The element
 * already occupies its final layout position (only a transform offset, no
 * height/display change), so nothing shifts layout or delays content per
 * §13's "never delays content from appearing." Under
 * prefers-reduced-motion, content stays at its default visible state and
 * no ScrollTrigger is created at all.
 */
export function Reveal({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;

    registerScrollTrigger();
    gsap.set(el, { opacity: 0, y: 24 });
    const trigger = ScrollTrigger.create({
      trigger: el,
      start: 'top 85%',
      once: true,
      onEnter: () =>
        gsap.to(el, { opacity: 1, y: 0, duration: 0.6, ease: 'power2.out' }),
    });

    return () => {
      trigger.kill();
      gsap.set(el, { clearProps: 'opacity,transform' });
    };
  }, []);

  return (
    <div className={className} ref={ref}>
      {children}
    </div>
  );
}
