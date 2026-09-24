'use client';

import * as React from 'react';
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';

import { cn } from '@/lib/utils';

/**
 * The terminal's shared controls and motion (design-brief.md §8, §13):
 * motion here is feedback only - a changed number ticks, a pressed
 * control answers, an indicator slides to the option chosen. Transform,
 * opacity and colour only, CSS and the Web Animations API only (no GSAP
 * or Lenis on /trade), and globals.css switches all of it off under
 * prefers-reduced-motion.
 */

/** True when the viewer asked for less motion; read at event time. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Press and hover feedback shared by every terminal button. */
export const PRESSABLE =
  'transition-[transform,background-color,border-color,color,opacity] duration-150 ease-out active:scale-[0.98] disabled:active:scale-100';

/** The ticket's main action, full width: filled YES green, NO red, or light for everything else. */
export function ctaClass(tone: 'up' | 'down' | 'neutral' = 'neutral'): string {
  return cn(
    'group/cta inline-flex h-12 w-full items-center justify-center gap-2 rounded-[2px] px-4 text-[15px] font-semibold disabled:cursor-not-allowed disabled:opacity-40',
    PRESSABLE,
    tone === 'up'
      ? 'bg-up text-background hover:bg-up/90'
      : tone === 'down'
        ? 'bg-down text-foreground hover:bg-down/90'
        : 'bg-foreground text-background hover:bg-foreground/90',
  );
}

/** A secondary action: hairline border, muted until hovered. */
export const QUIET_BUTTON = cn(
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-[2px] border border-border px-3 text-xs font-medium text-muted-foreground hover:border-foreground/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
  PRESSABLE,
);

/** A small preset (an amount, a range): mono, pressed state outlined. */
export const CHIP_BUTTON = cn(
  'h-8 rounded-[2px] border border-border px-2.5 font-mono text-xs tabular-nums text-muted-foreground hover:border-foreground/40 hover:text-foreground aria-pressed:border-foreground aria-pressed:text-foreground disabled:pointer-events-none disabled:opacity-40',
  PRESSABLE,
);

/** The arrow that leads a call to action; it nudges forward on hover. */
export function CtaArrow() {
  return (
    <svg
      aria-hidden="true"
      className="size-4 transition-transform duration-200 ease-out group-hover/cta:translate-x-0.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="square"
      strokeWidth="1.75"
      viewBox="0 0 16 16"
    >
      <path d="M2.5 8h10M8.5 4l4 4-4 4" />
    </svg>
  );
}

/**
 * A number that ticks when it changes: the new value slides in from below
 * when it rose, from above when it fell, and holds --up or --down for a
 * moment before returning to its own colour (terminal-tick-* in
 * globals.css). `numeric` orders the values; without it the value just
 * swaps in. The new figure is readable within 150ms.
 */
export function Ticker({
  value,
  numeric,
  className,
}: {
  value: string;
  numeric?: number;
  className?: string;
}) {
  const [previous, setPrevious] = React.useState({ value, numeric });
  const [direction, setDirection] = React.useState<'up' | 'down' | null>(null);
  // Derived from the props during render (React's documented pattern for
  // "state from the previous render"), so there is no effect and no flash
  // of the old value.
  if (previous.value !== value) {
    setPrevious({ value, numeric });
    setDirection(
      numeric === undefined || previous.numeric === undefined || numeric === previous.numeric
        ? null
        : numeric > previous.numeric
          ? 'up'
          : 'down',
    );
  }
  return (
    <span className={cn('inline-block tabular-nums', className)}>
      <span
        className={
          'inline-block ' +
          (direction === 'up' ? 'terminal-tick-up' : direction === 'down' ? 'terminal-tick-down' : '')
        }
        key={value}
      >
        {value}
      </span>
    </span>
  );
}

/**
 * A figure derived from what the viewer typed (what a buy returns) that
 * counts to its new value in under 300ms instead of jumping. `format` must
 * be stable (a module-level function), and renders the settled value on
 * the server and on first paint. The count writes the text node React owns,
 * so React's own update and the count never fight.
 */
export function CountTo({
  value,
  format,
  className,
}: {
  value: number;
  format: (value: number) => string;
  className?: string;
}) {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  const shown = React.useRef(value);

  // A layout effect, so the new value React just wrote never paints for a
  // frame before the count restarts from the old one.
  React.useLayoutEffect(() => {
    const node = ref.current?.firstChild;
    if (!node) return;
    const from = shown.current;
    const to = value;
    if (from === to || !Number.isFinite(from) || prefersReducedMotion()) {
      shown.current = to;
      node.nodeValue = format(to);
      return;
    }
    const start = performance.now();
    const duration = 280;
    let frame = 0;
    const step = (time: number) => {
      const k = Math.min(1, (time - start) / duration);
      const eased = 1 - (1 - k) ** 3;
      shown.current = from + (to - from) * eased;
      node.nodeValue = format(k === 1 ? to : shown.current);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      // Wherever the count stopped, the next one starts from the value
      // it was heading to, so an interrupted count never lands short.
      shown.current = to;
      node.nodeValue = format(to);
    };
  }, [value, format]);

  return (
    <span className={cn('tabular-nums', className)} ref={ref}>
      {format(value)}
    </span>
  );
}

/**
 * YES's share of the price as a thin two-colour bar: --up for YES, --down
 * for NO, the split at the YES price. It rescales (transform only) when
 * the price moves. `yesPercent` is 0-100; undefined draws the empty track.
 */
export function SplitBar({ yesPercent, className }: { yesPercent?: number; className?: string }) {
  const share = yesPercent === undefined ? 0 : Math.min(100, Math.max(0, yesPercent)) / 100;
  return (
    <div
      aria-hidden="true"
      className={cn(
        'h-[3px] w-full overflow-hidden rounded-[1px]',
        yesPercent === undefined ? 'bg-border' : 'bg-down/70',
        className,
      )}
    >
      <div
        className="h-full w-full origin-left bg-up transition-transform duration-500 ease-out"
        style={{ transform: `scaleX(${share})` }}
      />
    </div>
  );
}

/**
 * A labelled figure for the instrument bar: small mono label over a large
 * mono number. `lg` is the market's headline quote.
 */
export function Stat({
  label,
  children,
  tone,
  size = 'md',
  className,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  tone?: string;
  size?: 'md' | 'lg';
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-1.5 font-mono leading-none tabular-nums',
          size === 'lg' ? 'text-[28px] tracking-tight' : 'text-xl',
          tone ?? 'text-foreground',
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Tabs with an underline that slides to the active tab (base-ui's
 * indicator measures it). Use with the ui/tabs Tabs root and TabsContent.
 */
export function TerminalTabsList({ className, children, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      className={cn('relative flex items-center gap-5 overflow-x-auto border-b border-border', className)}
      {...props}
    >
      {children}
      <TabsPrimitive.Indicator className="absolute bottom-0 left-0 h-[2px] w-[var(--active-tab-width)] translate-x-[var(--active-tab-left)] bg-foreground transition-[translate,width] duration-200 ease-out" />
    </TabsPrimitive.List>
  );
}

export function TerminalTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        'shrink-0 whitespace-nowrap py-2.5 text-sm font-medium text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:text-foreground data-[active]:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A choice between a few options (a chart view, a range) with a box that
 * slides to the pressed one. The indicator is positioned straight on the
 * DOM, so a change of option never re-renders the control twice.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: readonly { id: T; label: string }[];
  /** The pressed option, or null when none is. */
  value: T | null;
  onChange: (value: T) => void;
  /** Accessible name for the group. */
  label: string;
  className?: string;
}) {
  const list = React.useRef<HTMLFieldSetElement | null>(null);
  const box = React.useRef<HTMLSpanElement | null>(null);
  const placed = React.useRef(false);

  React.useLayoutEffect(() => {
    const root = list.current;
    const indicator = box.current;
    if (!root || !indicator) return;
    const place = () => {
      const active = root.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (!active) {
        indicator.style.opacity = '0';
        return;
      }
      // The first placement lands without sliding in from the left edge.
      if (!placed.current) indicator.style.transition = 'none';
      indicator.style.opacity = '1';
      indicator.style.width = `${active.offsetWidth}px`;
      indicator.style.transform = `translateX(${active.offsetLeft}px)`;
      if (!placed.current) {
        void indicator.offsetWidth;
        indicator.style.transition = '';
        placed.current = true;
      }
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(root);
    return () => observer.disconnect();
  }, [value]);

  return (
    <fieldset
      className={cn('relative m-0 inline-flex min-w-0 items-center rounded-[2px] border border-border p-0.5', className)}
      ref={list}
    >
      <legend className="sr-only">{label}</legend>
      <span
        aria-hidden="true"
        className="absolute top-0.5 bottom-0.5 left-0 rounded-[2px] bg-accent opacity-0 transition-[transform,width,opacity] duration-200 ease-out"
        ref={box}
      />
      {options.map((option) => (
        <button
          aria-pressed={value === option.id}
          className={cn(
            'relative z-10 h-7 rounded-[2px] px-3 font-mono text-xs transition-colors duration-150',
            value === option.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
          key={option.id}
          onClick={() => onChange(option.id)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * A region of the terminal that rises into place once, on the page's
 * first load, `index` steps behind the first (terminal-rise in
 * globals.css). It already holds its final layout position, so nothing
 * shifts.
 */
export function Rise({
  index,
  className,
  children,
}: {
  index: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('terminal-rise', className)} style={{ '--rise-i': index } as React.CSSProperties}>
      {children}
    </div>
  );
}
