import { hedgeQuoteResult } from '@/lib/price-api';

import { readMarkets } from '../data';
import { apiRoute, json, preflight } from '../payment';

export const dynamic = 'force-dynamic';

/** GET /api/v1/hedge-quote?mw=&hours=&day=&protectTo=: a YES ladder for one day's load. */
export const GET = apiRoute(
  async (request) => {
    const query = new URL(request.url).searchParams;
    return json(await hedgeQuoteResult(query, Date.now(), readMarkets));
  },
  { paid: true, maxAge: 15 },
);

export const OPTIONS = preflight;
