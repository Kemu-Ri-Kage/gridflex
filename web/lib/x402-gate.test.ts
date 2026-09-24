import assert from 'node:assert/strict';
import { test } from 'node:test';

import { paymentConfig, paymentGate, type PaymentServer } from './x402-gate.ts';

const SECRETS = {
  OKX_API_KEY: 'key',
  OKX_SECRET_KEY: 'secret',
  OKX_PASSPHRASE: 'phrase',
  X402_PAY_TO: `0x${'a'.repeat(40)}`,
};

void test('payments are on only with every secret and a valid payee', () => {
  assert.deepEqual(paymentConfig(SECRETS, 'eip155:1952'), {
    apiKey: 'key',
    secretKey: 'secret',
    passphrase: 'phrase',
    payTo: SECRETS.X402_PAY_TO,
    network: 'eip155:1952',
  });
  assert.equal(paymentConfig({ ...SECRETS, X402_NETWORK: 'eip155:196' }, 'eip155:1952')?.network, 'eip155:196');
  assert.equal(paymentConfig({ ...SECRETS, OKX_PASSPHRASE: '' }, 'eip155:1952'), null);
  assert.equal(paymentConfig({ ...SECRETS, X402_PAY_TO: 'me' }, 'eip155:1952'), null);
  assert.equal(paymentConfig({}, 'eip155:1952'), null);
});

type Verified = Awaited<ReturnType<PaymentServer['processHTTPRequest']>>;

function fakeServer(result: Verified, settled = true) {
  const calls = { initialize: 0, settle: 0, paymentHeader: undefined as string | undefined };
  const server: PaymentServer = {
    initialize: async () => {
      calls.initialize += 1;
    },
    processHTTPRequest: async (context) => {
      calls.paymentHeader = context.paymentHeader;
      return result;
    },
    processSettlement: async () => {
      calls.settle += 1;
      return settled
        ? ({ success: true, headers: { 'PAYMENT-RESPONSE': 'receipt' } } as never)
        : ({
            success: false,
            headers: {},
            response: { status: 402, headers: {}, body: { error: 'settle failed' } },
          } as never);
    },
  };
  return { server, calls };
}

const verified = {
  type: 'payment-verified',
  paymentPayload: {},
  paymentRequirements: {},
} as unknown as Verified;

void test('an unpaid call gets the 402 requirements and never reaches the handler', async () => {
  const { server } = fakeServer({
    type: 'payment-error',
    response: { status: 402, headers: { 'PAYMENT-REQUIRED': 'reqs' }, body: { x402Version: 2 } },
  });
  let handled = false;
  const response = await paymentGate(server)(new Request('https://x.test/api/v1/price'), () => {
    handled = true;
    return Response.json({});
  });
  assert.equal(response.status, 402);
  assert.equal(response.headers.get('PAYMENT-REQUIRED'), 'reqs');
  assert.equal(handled, false);
});

void test('a paid call settles after a successful answer and carries the receipt', async () => {
  const { server, calls } = fakeServer(verified);
  const gate = paymentGate(server);
  const request = new Request('https://x.test/api/v1/price', {
    headers: { 'PAYMENT-SIGNATURE': 'signed' },
  });
  const response = await gate(request, () => Response.json({ value: 39.57 }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('PAYMENT-RESPONSE'), 'receipt');
  assert.deepEqual(await response.json(), { value: 39.57 });
  assert.equal(calls.paymentHeader, 'signed');
  assert.equal(calls.settle, 1);
  await gate(request, () => Response.json({}));
  assert.equal(calls.initialize, 1);
});

void test('a paid call the handler refuses is not settled, and a failed settlement withholds the data', async () => {
  const refused = fakeServer(verified);
  const response = await paymentGate(refused.server)(new Request('https://x.test/a'), () =>
    Response.json({ error: 'bad day' }, { status: 400 }),
  );
  assert.equal(response.status, 400);
  assert.equal(refused.calls.settle, 0);

  const unsettled = fakeServer(verified, false);
  const withheld = await paymentGate(unsettled.server)(new Request('https://x.test/a'), () =>
    Response.json({ value: 39.57 }),
  );
  assert.equal(withheld.status, 402);
  assert.deepEqual(await withheld.json(), { error: 'settle failed' });
});

void test('a facilitator that cannot start is a 502, retried on the next call', async () => {
  let attempts = 0;
  const server: PaymentServer = {
    initialize: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('down');
    },
    processHTTPRequest: async () => ({ type: 'no-payment-required' }),
    processSettlement: async () => {
      throw new Error('not called');
    },
  };
  const gate = paymentGate(server);
  const handler = () => Response.json({ ok: true });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal((await gate(new Request('https://x.test/a'), handler)).status, 502);
  } finally {
    console.error = originalError;
  }
  assert.equal((await gate(new Request('https://x.test/a'), handler)).status, 200);
  assert.equal(attempts, 2);
});
