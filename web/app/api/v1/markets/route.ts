import { marketsResult } from '@/lib/price-api';

import { readMarkets } from '../data';
import { apiRoute, json, preflight } from '../payment';

export const dynamic = 'force-dynamic';

/** GET /api/v1/markets?status=trading|all: the listed YES/NO questions, read from X Layer. */
export const GET = apiRoute(
  async (request) => {
    const status = new URL(request.url).searchParams.get('status');
    return json(await marketsResult(status, Date.now(), readMarkets));
  },
  { paid: true, maxAge: 15 },
);

export const OPTIONS = preflight;
