import { priceResult } from '@/lib/price-api';

import { evidence, oracleAddress, readOracle, records } from '../data';
import { apiRoute, json, preflight, requestQuery } from '../payment';

export const dynamic = 'force-dynamic';

/** GET or POST /api/v1/price?day=YYYY-MM-DD: one day's Texas power price and its oracle reading. */
export const GET = apiRoute(
  async (request) => {
    const day = (await requestQuery(request)).get('day');
    return json(await priceResult(records, evidence, oracleAddress, day, readOracle));
  },
  { paid: true, maxAge: 60 },
);

export const POST = GET;
export const OPTIONS = preflight;
