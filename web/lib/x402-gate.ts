import { Buffer } from 'node:buffer';

import type {
  HTTPAdapter,
  HTTPProcessResult,
  HTTPRequestContext,
  HTTPResponseInstructions,
  HTTPTransportContext,
  ProcessSettleResultResponse,
} from '@okxweb3/x402-core/server';
import { getFacilitatorResponseError } from '@okxweb3/x402-core/server';

/**
 * Charging for an API call with x402, on plain Web Request and Response.
 * The same steps as @okxweb3/x402-next's withX402, which needs the real
 * next/server rather than vinext's: verify the payment header before the
 * handler runs, answer 402 with the requirements when it is missing or
 * wrong, and settle only after the handler answers below 400, so a
 * request refused for bad parameters is never charged.
 */

/** The parts of x402HTTPResourceServer the gate calls. */
export interface PaymentServer {
  initialize(): Promise<void>;
  processHTTPRequest(context: HTTPRequestContext): Promise<HTTPProcessResult>;
  processSettlement(
    paymentPayload: Extract<HTTPProcessResult, { type: 'payment-verified' }>['paymentPayload'],
    requirements: Extract<HTTPProcessResult, { type: 'payment-verified' }>['paymentRequirements'],
    declaredExtensions?: Record<string, unknown>,
    transportContext?: HTTPTransportContext,
  ): Promise<ProcessSettleResultResponse>;
}

export type Handler = (request: Request) => Response | Promise<Response>;

/** What the API needs to charge: every secret present and a valid payee. */
export interface PaymentConfig {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  payTo: string;
  network: `eip155:${string}`;
}

/**
 * The payment settings from the Worker's environment, or null (free mode)
 * when any secret is missing or the payee or network isn't valid.
 */
export function paymentConfig(
  env: Record<string, unknown>,
  defaultNetwork: `eip155:${string}`,
): PaymentConfig | null {
  const text = (name: string) => {
    const value = env[name];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };
  const apiKey = text('OKX_API_KEY');
  const secretKey = text('OKX_SECRET_KEY');
  const passphrase = text('OKX_PASSPHRASE');
  const payTo = text('X402_PAY_TO');
  const network = text('X402_NETWORK') ?? defaultNetwork;
  if (!apiKey || !secretKey || !passphrase || !payTo) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo) || !/^eip155:\d+$/.test(network)) return null;
  return { apiKey, secretKey, passphrase, payTo, network: network as `eip155:${string}` };
}

function adapterFor(request: Request, url: URL): HTTPAdapter {
  return {
    getHeader: (name) => request.headers.get(name) ?? undefined,
    getMethod: () => request.method,
    getPath: () => url.pathname,
    getUrl: () => request.url,
    getAcceptHeader: () => request.headers.get('Accept') ?? '',
    getUserAgent: () => request.headers.get('User-Agent') ?? '',
    getQueryParams: () => {
      const params: Record<string, string | string[]> = {};
      for (const key of new Set(url.searchParams.keys())) {
        const all = url.searchParams.getAll(key);
        params[key] = all.length === 1 ? all[0] : all;
      }
      return params;
    },
    getQueryParam: (name) => {
      const all = url.searchParams.getAll(name);
      if (all.length === 0) return undefined;
      return all.length === 1 ? all[0] : all;
    },
  };
}

function instructionsResponse(instructions: HTTPResponseInstructions): Response {
  const headers = new Headers(instructions.headers);
  if (instructions.isHtml) {
    headers.set('Content-Type', 'text/html');
    return new Response(instructions.body as string, { status: instructions.status, headers });
  }
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(instructions.body ?? {}), {
    status: instructions.status,
    headers,
  });
}

function facilitatorFailure(error: unknown): Response {
  const facilitatorError = getFacilitatorResponseError(error);
  if (!facilitatorError) console.error('x402 payment failed:', error);
  return Response.json(
    { error: facilitatorError?.message ?? 'The payment facilitator could not be reached.' },
    { status: 502 },
  );
}

/**
 * Wraps handlers so each call is paid. Initialises the server once,
 * retrying on the next request after a failure.
 */
export function paymentGate(server: PaymentServer) {
  let ready: Promise<void> | null = null;
  const init = async () => {
    ready ??= server.initialize();
    try {
      await ready;
    } catch (error) {
      ready = null;
      throw error;
    }
  };

  return async (request: Request, handler: Handler): Promise<Response> => {
    const url = new URL(request.url);
    const adapter = adapterFor(request, url);
    const context: HTTPRequestContext = {
      adapter,
      path: url.pathname,
      method: request.method,
      paymentHeader: adapter.getHeader('payment-signature') ?? adapter.getHeader('x-payment'),
    };

    let result: HTTPProcessResult;
    try {
      await init();
      result = await server.processHTTPRequest(context);
    } catch (error) {
      return facilitatorFailure(error);
    }
    if (result.type === 'no-payment-required') return handler(request);
    if (result.type === 'payment-error') return instructionsResponse(result.response);

    const response = await handler(request);
    if (response.status >= 400) return response;
    try {
      const settled = await server.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        {
          request: context,
          responseBody: Buffer.from(await response.clone().arrayBuffer()),
        },
      );
      if (!settled.success) return instructionsResponse(settled.response);
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(settled.headers)) headers.set(name, value);
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      // As withX402: a facilitator error is a 502; anything else leaves
      // the call unpaid, so the data is withheld.
      if (getFacilitatorResponseError(error)) return facilitatorFailure(error);
      console.error('x402 settlement failed:', error);
      return Response.json({ error: 'The payment could not be settled.' }, { status: 402 });
    }
  };
}
