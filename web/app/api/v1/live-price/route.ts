import { env } from 'cloudflare:workers';

import {
  cacheSeconds,
  liveQueryUrl,
  parseLiveRows,
  type LivePrice,
  type LivePriceResponse,
} from '@/lib/live-price';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/live-price: the latest 5-minute ERCOT North Hub price, read
 * from GridStatus with the Worker secret GRIDSTATUS_API_KEY. Without the
 * secret it answers { configured: false } and the site shows no live price.
 * Free, unlike the paid x402 endpoints; not listed in ENDPOINTS.
 */

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json; charset=utf-8',
};

// One GridStatus read per isolate until the next interval is likely out.
// Only a finished read is kept: a Worker must not share a pending promise
// between requests.
let kept: { until: number; fetchedAt: string; live: LivePrice } | null = null;

function apiKey(): string | null {
  const value = (env as unknown as Record<string, unknown>).GRIDSTATUS_API_KEY;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function respond(
  body: LivePriceResponse,
  maxAge: number,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...HEADERS, 'Cache-Control': `public, max-age=${maxAge}` },
  });
}

export async function GET(): Promise<Response> {
  const now = Date.now();
  const key = apiKey();
  if (!key)
    return respond(
      { configured: false, live: null, fetchedAt: new Date(now).toISOString() },
      300,
    );

  if (kept && now < kept.until) {
    return respond(
      { configured: true, live: kept.live, fetchedAt: kept.fetchedAt },
      Math.ceil((kept.until - now) / 1000),
    );
  }

  try {
    const response = await fetch(liveQueryUrl(now), {
      headers: { 'x-api-key': key, 'x-client': 'gridflex-web' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`GridStatus answered ${response.status}`);
    const payload = (await response.json()) as { data?: unknown };
    const live = parseLiveRows(payload.data);
    if (!live) throw new Error('GridStatus returned no usable rows');
    const seconds = cacheSeconds(live.intervalEndUtc, now);
    const fetchedAt = new Date(now).toISOString();
    kept = { until: now + seconds * 1000, fetchedAt, live };
    return respond({ configured: true, live, fetchedAt }, seconds);
  } catch {
    // The last good read if there is one (the strip marks it delayed once it
    // is 15 minutes old). Never the error itself: it can describe the request.
    if (kept)
      return respond(
        { configured: true, live: kept.live, fetchedAt: kept.fetchedAt },
        30,
      );
    return respond(
      { configured: true, live: null, fetchedAt: new Date(now).toISOString() },
      30,
      502,
    );
  }
}
