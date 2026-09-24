import { marketsResult } from '@/lib/price-api';

import { readMarkets } from '../data';
import { apiRoute, json, preflight, requestQuery } from '../payment';

export const dynamic = 'force-dynamic';

/** GET or POST /api/v1/markets?status=trading|all: the listed YES/NO questions, read from X Layer. */
export const GET = apiRoute(
  async (request) => {
    const status = (await requestQuery(request)).get('status');
    return json(await marketsResult(status, Date.now(), readMarkets));
  },
  { paid: true, maxAge: 15 },
);

export const POST = GET;
export const OPTIONS = preflight;
