import { priceResult } from '@/lib/price-api';

import { evidence, oracleAddress, readOracle, records } from '../data';
import { apiRoute, json, preflight } from '../payment';

export const dynamic = 'force-dynamic';

/** GET /api/v1/price?day=YYYY-MM-DD: one day's Texas power price and its oracle reading. */
export const GET = apiRoute(
  async (request) => {
    const day = new URL(request.url).searchParams.get('day');
    return json(await priceResult(records, evidence, oracleAddress, day, readOracle));
  },
  { paid: true, maxAge: 60 },
);

export const OPTIONS = preflight;
