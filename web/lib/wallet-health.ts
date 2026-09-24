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
 * Chosen without measured OKX Wallet timings, so erring long: warning a
 * wallet that works is far worse than warning late, since the warning never
 * blocks a request. The public X Layer testnet RPCs answer in well under
 * 2s; the slowest working wallet seen answered in 4s (and was reported dead
 * at the old 3s timeout). 15s is several times that.
 */
export const WALLET_PROBE_TIMEOUT_MS = 15_000;

/**
 * Failed probes needed, all in a row, before the RPC is called unreachable,
 * and the wait between them. Spread over the window so a wallet still
 * settling after a connect or chain switch, or one slow moment of its RPC,
 * can't produce the warning: with a dead RPC the verdict lands about 1m45s
 * in (4 probes timing out at 15s, 15s apart).
 */
export const WALLET_PROBE_ATTEMPTS = 4;
export const WALLET_PROBE_SPACING_MS = 15_000;

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

type CheckOptions = {
  timeoutMs?: number;
  attempts?: number;
  spacingMs?: number;
  /**
   * Whether this check's verdict is still wanted (see rpcCheckGate); asked
   * before every request, and the check ends `unknown` once it says no.
   */
  stillWanted?: () => boolean;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Judge the wallet's saved RPC for `chainId`: `unreachable` only when a
 * connected, unlocked wallet on that chain fails every one of `attempts`
 * probes spread over the window, and is still connected, unlocked and on
 * that chain before each one and afterwards (a wallet that locked or
 * switched mid-check failed for that reason instead). One answer anywhere
 * in the window is `reachable`.
 */
export async function checkWalletRpc(
  request: WalletRequest,
  chainId: number,
  {
    timeoutMs = WALLET_PROBE_TIMEOUT_MS,
    attempts = WALLET_PROBE_ATTEMPTS,
    spacingMs = WALLET_PROBE_SPACING_MS,
    stillWanted = () => true,
  }: CheckOptions = {},
): Promise<WalletRpcVerdict> {
  const judgeable = async () =>
    stillWanted() && (await walletReady(request, chainId, timeoutMs));
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(spacingMs);
    if (!(await judgeable())) return 'unknown';
    if ((await probeWalletRpc(request, timeoutMs)) === 'ok') return 'reachable';
  }
  return (await judgeable()) && stillWanted() ? 'unreachable' : 'unknown';
}

/**
 * Decides whose health-check verdict may still land. Each check takes a
 * token when it starts; the token goes stale when a newer check starts, a
 * wallet prompt opens (so a check never probes while one is open, and one
 * started before the prompt is dropped), or a transaction succeeds (proof
 * the RPC works, which a check already running must not overturn).
 */
export function rpcCheckGate() {
  let generation = 0;
  let promptsOpen = 0;
  return {
    begin(): () => boolean {
      const token = ++generation;
      return () => token === generation && promptsOpen === 0;
    },
    /** A wallet prompt is opening; call the result once it has closed. */
    hold(): () => void {
      generation++;
      promptsOpen++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        promptsOpen--;
      };
    },
    /** A transaction went through: every check in flight is stale. */
    succeeded() {
      generation++;
    },
  };
}
