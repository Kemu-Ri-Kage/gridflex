import { env } from 'cloudflare:workers';
import { OKXFacilitatorClient } from '@okxweb3/x402-core';
import { x402HTTPResourceServer, x402ResourceServer } from '@okxweb3/x402-core/server';
import { ExactEvmScheme } from '@okxweb3/x402-evm/exact/server';

import {
  API_ASSET,
  API_PRICE,
  DEFAULT_NETWORK,
  ENDPOINTS,
  type PaymentInfo,
} from '@/lib/price-api';
import { paymentConfig, paymentGate, type Handler, type PaymentConfig } from '@/lib/x402-gate';

/**
 * The API's shared response wrapper: charges the paid endpoints through
 * the OKX facilitator when the Worker has its secrets (OKX_API_KEY,
 * OKX_SECRET_KEY, OKX_PASSPHRASE, X402_PAY_TO, optional X402_NETWORK),
 * and serves them free otherwise, saying so in X-GRIDFLEX-Payment.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'PAYMENT-SIGNATURE, X-PAYMENT, Content-Type, Accept',
  'Access-Control-Expose-Headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-GRIDFLEX-Payment',
  'Access-Control-Max-Age': '86400',
};

function currentConfig(): PaymentConfig | null {
  return paymentConfig(env as unknown as Record<string, unknown>, DEFAULT_NETWORK);
}

export function currentNetwork(): string {
  return currentConfig()?.network ?? DEFAULT_NETWORK;
}

export function paymentInfo(): PaymentInfo {
  const config = currentConfig();
  return {
    mode: config ? 'x402' : 'free',
    price: API_PRICE,
    asset: API_ASSET,
    payTo: config?.payTo ?? null,
  };
}

// One facilitator client and resource server per isolate, built on the
// first paid call and rebuilt only if the secrets change.
let gate: { key: string; run: ReturnType<typeof paymentGate> } | null = null;

function gateFor(config: PaymentConfig) {
  const key = JSON.stringify(config);
  if (gate?.key === key) return gate.run;
  const facilitator = new OKXFacilitatorClient({
    apiKey: config.apiKey,
    secretKey: config.secretKey,
    passphrase: config.passphrase,
  });
  const resourceServer = new x402ResourceServer(facilitator).register(
    config.network,
    new ExactEvmScheme(),
  );
  // GET and POST alike: marketplaces probe endpoints with either.
  const routes = Object.fromEntries(
    ENDPOINTS.flatMap((endpoint) =>
      ['GET', 'POST'].map((method) => [
        `${method} ${endpoint.path}`,
      {
        accepts: {
          scheme: 'exact',
          network: config.network,
          payTo: config.payTo,
          price: API_PRICE,
        },
        description: endpoint.description,
        mimeType: 'application/json',
      },
    ]),
    ),
  );
  gate = { key, run: paymentGate(new x402HTTPResourceServer(resourceServer, routes)) };
  return gate.run;
}

/**
 * A GET handler with CORS, Cache-Control and X-GRIDFLEX-Payment on every
 * response. A paid response is never cached: each call is its own payment.
 */
export function apiRoute(handler: Handler, options: { paid: boolean; maxAge: number }) {
  return async (request: Request): Promise<Response> => {
    const config = options.paid ? currentConfig() : null;
    const response = config ? await gateFor(config)(request, handler) : await handler(request);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
    headers.set('X-GRIDFLEX-Payment', config ? 'x402' : 'free');
    headers.set(
      'Cache-Control',
      config || response.status >= 400 ? 'no-store' : `public, max-age=${options.maxAge}`,
    );
    return new Response(response.body, { status: response.status, headers });
  };
}

/**
 * A call's parameters: the query string, plus the fields of a JSON object
 * body on a POST (the query string wins where both name one). Agents and
 * marketplaces call with either method; a body that isn't a JSON object
 * is ignored.
 */
export async function requestQuery(request: Request): Promise<URLSearchParams> {
  const query = new URL(request.url).searchParams;
  if (request.method !== 'POST') return query;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return query;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return query;
  const merged = new URLSearchParams(query);
  for (const [name, value] of Object.entries(body)) {
    if (!merged.has(name) && (typeof value === 'string' || typeof value === 'number')) {
      merged.set(name, String(value));
    }
  }
  return merged;
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function json(result: { status: number; body: unknown }): Response {
  return Response.json(result.body, { status: result.status });
}
