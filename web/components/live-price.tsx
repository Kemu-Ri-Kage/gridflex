'use client';

import { useEffect, useState } from 'react';

import {
  isStale,
  priceChange,
  texasClock,
  type LivePriceResponse,
} from '@/lib/live-price';
import { cn } from '@/lib/utils';

const POLL_MS = 60_000;

/**
 * The live Texas power price in the terminal header: the latest 5-minute
 * ERCOT North Hub price, its change from the interval before, and the
 * interval in Texas time. It sits in the header's fixed height, so it
 * appearing never moves the page (design-brief.md §13, no layout shift).
 * Renders nothing until the Worker has its GridStatus key, or while no price
 * has been read.
 */
export function LivePriceChip({ className }: { className?: string }) {
  const [data, setData] = useState<LivePriceResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch('/api/v1/live-price', {
          cache: 'no-store',
        });
        const body = (await response.json()) as LivePriceResponse;
        if (alive) setData(body);
      } catch {
        // keep the last price; the next poll tries again
      }
      if (alive) setNow(Date.now());
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const live = data?.configured ? data.live : null;
  if (!live) return null;

  const change = priceChange(live);
  const stale = isStale(live.intervalEndUtc, now);
  return (
    <output
      aria-label={`Texas power price, North Hub: $${live.price.toFixed(2)} per MWh${stale ? ', delayed' : ''}`}
      className={cn(
        'items-center gap-2.5 whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground',
        className,
      )}
      title={`5-minute ERCOT North Hub price for ${texasClock(live.intervalStartUtc)}-${texasClock(live.intervalEndUtc)} Texas time${
        live.index === null ? '' : `; 15-minute index $${live.index.toFixed(2)}`
      }`}
    >
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-full',
            stale ? 'bg-muted-foreground' : 'animate-pulse bg-up',
          )}
        />
        {stale ? 'Delayed' : 'Live'}
      </span>
      <span className="text-sm font-semibold normal-case tracking-normal text-foreground tabular-nums">
        ${live.price.toFixed(2)}
        <span className="ml-0.5 text-[11px] font-normal text-muted-foreground">
          /MWh
        </span>
      </span>
      {change !== null && (
        <span
          className={cn(
            'tabular-nums',
            change > 0 && 'text-up',
            change < 0 && 'text-down',
          )}
        >
          {change > 0 ? '▲' : change < 0 ? '▼' : '•'}{' '}
          {Math.abs(change).toFixed(2)}
        </span>
      )}
      <span className="hidden tabular-nums xl:inline">
        {texasClock(live.intervalEndUtc)} Texas
      </span>
    </output>
  );
}
