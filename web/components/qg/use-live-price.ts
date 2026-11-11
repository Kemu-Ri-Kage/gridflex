'use client';

import { useEffect, useState } from 'react';

import { isStale, type LivePrice, type LivePriceResponse } from '@/lib/live-price';

const POLL_MS = 60_000;

/**
 * The latest 5-minute ERCOT North Hub price from /api/v1/live-price, polled
 * every minute and on return to the tab. null until the Worker has its
 * GridStatus key and a price has been read; `stale` once it is older than
 * fifteen minutes.
 */
export function useLivePrice(): { live: LivePrice | null; stale: boolean } {
  const [live, setLive] = useState<LivePrice | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch('/api/v1/live-price', { cache: 'no-store' });
        const body = (await response.json()) as LivePriceResponse;
        if (alive && body.configured && body.live) setLive(body.live);
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

  return { live, stale: live ? isStale(live.intervalEndUtc, now) : false };
}
