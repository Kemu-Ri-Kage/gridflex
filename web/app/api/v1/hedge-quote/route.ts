import { hedgeQuoteResult } from '@/lib/price-api';

import { readMarkets } from '../data';
import { apiRoute, json, preflight, requestQuery } from '../payment';

export const dynamic = 'force-dynamic';

/** GET or POST /api/v1/hedge-quote?mw=&hours=&day=&protectTo=: a YES ladder for one day's load. */
export const GET = apiRoute(
  async (request) => {
    const query = await requestQuery(request);
    return json(await hedgeQuoteResult(query, Date.now(), readMarkets));
  },
  { paid: true, maxAge: 15 },
);

export const POST = GET;
export const OPTIONS = preflight;
