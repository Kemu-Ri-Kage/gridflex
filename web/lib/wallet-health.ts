/**
 * Whether the wallet's own saved RPC for X Layer answers. A wallet runs its
 * gas estimate, nonce and fee lookups through that RPC before it shows a
 * prompt, so a dead one leaves eth_sendTransaction pending forever with
 * nothing on screen. This site can't see or change that RPC; it can only
 * notice and offer the connection help (components/connection-help.tsx).
 * Kept free of imports for the node tests.
 */

export type WalletRpcHealth = 'ok' | 'timeout' | 'error';

/**
 * What the site concludes about the wallet's saved RPC. `unknown` covers
 * every case where a failed probe wouldn't mean a dead RPC: the wallet is
 * locked, hasn't approved the site, is on another chain, or stopped
 * answering the precondition check. Only `unreachable` shows the
 * connection help, and no verdict ever stops a request being sent.
 */
export type WalletRpcVerdict = 'reachable' | 'unreachable' | 'unknown';

type WalletRequest = (args: { method: string }) => Promise<unknown>;

/**
 * Long enough for a slow but working wallet: the public X Layer testnet
 * RPCs answer in well under 2s, and the wallet adds its own overhead on top.
 * At 3s, a wallet answering in 4s was reported dead.
 */
export const WALLET_PROBE_TIMEOUT_MS = 10_000;

/** `promise`'s outcome, or `onTimeout` if it hasn't settled in `timeoutMs`. */
async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), timeoutMs);
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One cheap read through the wallet, raced against `timeoutMs`.
 * eth_blockNumber rather than eth_chainId: wallets answer eth_chainId from
 * their own settings, so it succeeds even when the RPC is dead.
 */
export function probeWalletRpc(
  request: WalletRequest,
  timeoutMs = WALLET_PROBE_TIMEOUT_MS,
): Promise<WalletRpcHealth> {
  const answered = request({ method: 'eth_blockNumber' }).then(
    (result): WalletRpcHealth =>
      typeof result === 'string' && /^0x[0-9a-f]+$/i.test(result)
        ? 'ok'
        : 'error',
    (): WalletRpcHealth => 'error',
  );
  return within(answered, timeoutMs, 'timeout');
}

/**
 * Whether the wallet has an account unlocked for this site and is on
 * `chainId`. Both are answered by the wallet itself, not its RPC, so a
 * probe that fails without these holding says nothing about the RPC.
 */
async function walletReady(
  request: WalletRequest,
  chainId: number,
  timeoutMs: number,
): Promise<boolean> {
  const ready = Promise.all([
    request({ method: 'eth_accounts' }),
    request({ method: 'eth_chainId' }),
  ]).then(
    ([accounts, current]) =>
      Array.isArray(accounts) &&
      accounts.length > 0 &&
      (typeof current === 'string' || typeof current === 'number') &&
      Number(current) === chainId,
    () => false,
  );
  return within(ready, timeoutMs, false);
}

/**
 * Judge the wallet's saved RPC for `chainId`: `unreachable` only when a
 * connected, unlocked wallet on that chain fails the probe twice in a row,
 * and is still connected, unlocked and on that chain afterwards (a wallet
 * that locked or switched mid-check failed for that reason instead).
 */
export async function checkWalletRpc(
  request: WalletRequest,
  chainId: number,
  timeoutMs = WALLET_PROBE_TIMEOUT_MS,
): Promise<WalletRpcVerdict> {
  if (!(await walletReady(request, chainId, timeoutMs))) return 'unknown';
  for (let attempt = 0; attempt < 2; attempt++) {
    if ((await probeWalletRpc(request, timeoutMs)) === 'ok') return 'reachable';
  }
  return (await walletReady(request, chainId, timeoutMs))
    ? 'unreachable'
    : 'unknown';
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
