import { apiIndex } from '@/lib/price-api';

import { apiRoute, currentNetwork, paymentInfo, preflight } from './payment';

export const dynamic = 'force-dynamic';

/** GET /api/v1: what the API offers and how it is paid for. Always free. */
export const GET = apiRoute(() => Response.json(apiIndex(paymentInfo(), currentNetwork())), {
  paid: false,
  maxAge: 300,
});

export const OPTIONS = preflight;
