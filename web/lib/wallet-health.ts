/**
 * Whether the wallet's own saved RPC for X Layer answers. A wallet runs its
 * gas estimate, nonce and fee lookups through that RPC before it shows a
 * prompt, so a dead one leaves eth_sendTransaction pending forever with
 * nothing on screen. This site can't see or change that RPC; it can only
 * notice and offer the connection help (components/connection-help.tsx).
 * Kept free of imports for the node tests.
 */

export type WalletRpcHealth = 'ok' | 'timeout' | 'error';

type WalletRequest = (args: { method: string }) => Promise<unknown>;

export const WALLET_PROBE_TIMEOUT_MS = 3_000;

/**
 * One cheap read through the wallet, raced against `timeoutMs`.
 * eth_blockNumber rather than eth_chainId: wallets answer eth_chainId from
 * their own settings, so it succeeds even when the RPC is dead.
 */
export async function probeWalletRpc(
  request: WalletRequest,
  timeoutMs = WALLET_PROBE_TIMEOUT_MS,
): Promise<WalletRpcHealth> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const answered = request({ method: 'eth_blockNumber' }).then(
    (result): WalletRpcHealth =>
      typeof result === 'string' && /^0x[0-9a-f]+$/i.test(result)
        ? 'ok'
        : 'error',
    (): WalletRpcHealth => 'error',
  );
  try {
    return await Promise.race([answered, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export const SLOW_WALLET_REQUEST_MS = 8_000;

/**
 * Resolve as `request` does, calling `onSlow` each `afterMs` it stays
 * pending, until it settles or `onSlow` returns false. This never abandons
 * the request: a wallet prompt can't be withdrawn, and a transaction the
 * wallet sends late must still be tracked.
 */
export function watchSlowRequest<T>(
  request: Promise<T>,
  onSlow: () => Promise<boolean>,
  afterMs = SLOW_WALLET_REQUEST_MS,
): Promise<T> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimeout(() => {
      void onSlow().then(
        (keepWatching) => {
          if (keepWatching && !settled) schedule();
        },
        () => {},
      );
    }, afterMs);
  };
  schedule();
  return request.finally(() => {
    settled = true;
    clearTimeout(timer);
  });
}
