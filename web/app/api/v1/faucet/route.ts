import { env } from 'cloudflare:workers';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  isAddress,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { mockUsdtAbi, xLayerTestnet, xLayerTransport } from '@/lib/contracts';
import {
  FAUCET_GAS_WEI,
  FAUCET_MUSDT_UNITS,
  faucetPlan,
  type FaucetResult,
  type FaucetStatus,
} from '@/lib/faucet';
import type { PublicAddresses } from '@/lib/site-data';
import addressesJson from '@/public/data/addresses.json';

/**
 * GRIDFLEX's test-funds faucet (lib/faucet.ts has the rules).
 *
 * GET  /api/v1/faucet   whether it is switched on, and the bot check's site key
 * POST /api/v1/faucet   { address, turnstileToken } -> tops the wallet up
 *
 * Off until the Worker has FAUCET_PRIVATE_KEY, the key of a dedicated,
 * low-balance testnet wallet that only ever sends test OKB and mints mUSDT.
 * With TURNSTILE_SECRET_KEY (and TURNSTILE_SITE_KEY for the page) every
 * request must also pass Cloudflare Turnstile. The key is never logged or
 * returned; only transaction hashes are. Same-origin only: no CORS headers.
 */

export const dynamic = 'force-dynamic';

type FaucetEnv = {
  FAUCET_PRIVATE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
};

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const RECEIPT_TIMEOUT_MS = 60_000;

function faucetEnv(): FaucetEnv {
  return env as unknown as FaucetEnv;
}

function json(body: FaucetResult | FaucetStatus, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function failure(error: string, status: number): Response {
  return json({ ok: false, error }, status);
}

export async function GET(): Promise<Response> {
  const config = faucetEnv();
  return json({
    enabled: Boolean(config.FAUCET_PRIVATE_KEY),
    turnstileSiteKey: config.TURNSTILE_SECRET_KEY ? (config.TURNSTILE_SITE_KEY ?? null) : null,
  });
}

async function passesTurnstile(secret: string, token: string, ip: string | null): Promise<boolean> {
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  try {
    const answer = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body: form });
    const result = (await answer.json()) as { success?: boolean };
    return result.success === true;
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  const config = faucetEnv();
  if (!config.FAUCET_PRIVATE_KEY) {
    return failure('The test-funds faucet is not switched on yet.', 503);
  }

  const body = (await request.json().catch(() => null)) as {
    address?: unknown;
    turnstileToken?: unknown;
  } | null;
  if (!body || typeof body.address !== 'string' || !isAddress(body.address)) {
    return failure('Send a wallet address.', 400);
  }
  const to: Address = getAddress(body.address);

  if (config.TURNSTILE_SECRET_KEY) {
    const token = typeof body.turnstileToken === 'string' ? body.turnstileToken : '';
    const ip = request.headers.get('CF-Connecting-IP');
    if (!token || !(await passesTurnstile(config.TURNSTILE_SECRET_KEY, token, ip))) {
      return failure('The human check did not pass. Try again.', 403);
    }
  }

  const collateral = getAddress((addressesJson as PublicAddresses).MockUSDT);
  const publicClient = createPublicClient({ chain: xLayerTestnet, transport: xLayerTransport() });

  try {
    const [gasWei, musdtUnits] = await Promise.all([
      publicClient.getBalance({ address: to }),
      publicClient.readContract({
        address: collateral,
        abi: mockUsdtAbi,
        functionName: 'balanceOf',
        args: [to],
      }) as Promise<bigint>,
    ]);
    const plan = faucetPlan({ gasWei, musdtUnits });
    if (!plan.gas && !plan.musdt) return json({ ok: true, sent: {} });

    const account = privateKeyToAccount(config.FAUCET_PRIVATE_KEY as Hex);
    const wallet = createWalletClient({ account, chain: xLayerTestnet, transport: xLayerTransport() });
    // Never below the confirmed count: some public X Layer nodes report a
    // stale pending count (publish.py safe_nonce has the same rule).
    const [pending, latest] = await Promise.all([
      publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
      publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' }),
    ]);
    let nonce = Math.max(pending, latest);

    const sent: { gas?: Hash; musdt?: Hash } = {};
    if (plan.gas) {
      sent.gas = await wallet.sendTransaction({ to, value: FAUCET_GAS_WEI, nonce: nonce++ });
    }
    if (plan.musdt) {
      sent.musdt = await wallet.writeContract({
        address: collateral,
        abi: mockUsdtAbi,
        functionName: 'mint',
        args: [to, FAUCET_MUSDT_UNITS],
        nonce: nonce++,
      });
    }
    await Promise.all(
      Object.values(sent).map((hash) =>
        publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS }),
      ),
    );
    console.log(JSON.stringify({ faucet: to, ...sent }));
    return json({ ok: true, sent });
  } catch (error) {
    console.error('faucet failed', error instanceof Error ? error.name : 'unknown');
    return failure(
      'Could not send test funds right now. Try again in a minute, or use the OKX faucet link.',
      502,
    );
  }
}
