/**
 * Which browser wallets are installed, and which one Connect should use.
 *
 * Wallets announce themselves through EIP-6963: the page dispatches
 * `eip6963:requestProvider` and every installed wallet answers with an
 * `eip6963:announceProvider` event carrying its name, icon, rdns and
 * provider. That finds every wallet instead of whichever one won the race
 * for `window.ethereum` (with OKX Wallet and MetaMask both installed in
 * Chrome, `window.ethereum` is MetaMask's). Older extensions predate the
 * standard, so when nothing announces, `window.okxwallet` (OKX's own
 * documented global) and `window.ethereum` are used instead.
 * Kept free of imports for the node tests.
 */

/** The EIP-1193 surface this site uses. */
export type WalletProvider = {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => void;
  isOkxWallet?: boolean;
};

export type WalletInfo = {
  /** EIP-6963 uuid, or the global's name for a wallet that didn't announce. */
  id: string;
  name: string;
  /** A data: URI from the announcement; absent for an older wallet. */
  icon?: string;
  /** Reverse-DNS id from the announcement, e.g. `io.metamask`. */
  rdns?: string;
};

export type DiscoveredWallet = { info: WalletInfo; provider: WalletProvider };

/** Both read from the announcements in Chrome, 24 Sep 2026. */
export const OKX_RDNS = 'com.okex.wallet';
export const METAMASK_RDNS = 'io.metamask';

export type AnnounceDetail = {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: WalletProvider;
};

/** The parts of `window` discovery touches, so tests can pass a fake. */
export type DiscoveryWindow = {
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  removeEventListener: (type: string, listener: (event: Event) => void) => void;
  dispatchEvent: (event: Event) => boolean;
  okxwallet?: WalletProvider;
  ethereum?: WalletProvider;
};

const ANNOUNCE = 'eip6963:announceProvider';
const REQUEST = 'eip6963:requestProvider';

function isAnnounceDetail(detail: unknown): detail is AnnounceDetail {
  if (!detail || typeof detail !== 'object') return false;
  const { info, provider } = detail as Partial<AnnounceDetail>;
  return (
    typeof info?.uuid === 'string' &&
    typeof info.name === 'string' &&
    typeof provider?.request === 'function'
  );
}

/** Wallets that didn't announce: OKX's own global first, then window.ethereum. */
function legacyWallets(win: DiscoveryWindow): DiscoveredWallet[] {
  const wallets: DiscoveredWallet[] = [];
  const okx = win.okxwallet;
  if (typeof okx?.request === 'function') {
    wallets.push({
      info: { id: 'window.okxwallet', name: 'OKX Wallet', rdns: OKX_RDNS },
      provider: okx,
    });
  }
  const ethereum = win.ethereum;
  // Skip window.ethereum when it is OKX's provider again. isMetaMask is not
  // checked for anything: OKX sets it too.
  if (
    typeof ethereum?.request === 'function' &&
    ethereum !== okx &&
    !(okx && ethereum.isOkxWallet)
  ) {
    wallets.push({
      info: { id: 'window.ethereum', name: 'Browser wallet' },
      provider: ethereum,
    });
  }
  return wallets;
}

/** OKX Wallet first (this is the OKX hackathon), then in announcement order. */
function okxFirst(wallets: DiscoveredWallet[]): DiscoveredWallet[] {
  return [
    ...wallets.filter((wallet) => wallet.info.rdns === OKX_RDNS),
    ...wallets.filter((wallet) => wallet.info.rdns !== OKX_RDNS),
  ];
}

/**
 * Start listening for announcements and ask every wallet to announce.
 * `onChange` gets the full list each time it changes; `current()` asks
 * again and returns the list as it stands now, which Connect uses so a
 * wallet that loaded late is still found.
 */
export function watchWallets(
  win: DiscoveryWindow,
  onChange: (wallets: DiscoveredWallet[]) => void,
): { current: () => DiscoveredWallet[]; stop: () => void } {
  const announced = new Map<string, DiscoveredWallet>();

  const list = (): DiscoveredWallet[] =>
    announced.size > 0 ? okxFirst([...announced.values()]) : legacyWallets(win);

  const handleAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isAnnounceDetail(detail)) return;
    const { info, provider } = detail;
    if (announced.get(info.uuid)?.provider === provider) return;
    announced.set(info.uuid, {
      info: {
        id: info.uuid,
        name: info.name,
        icon: info.icon || undefined,
        rdns: info.rdns || undefined,
      },
      provider,
    });
    onChange(list());
  };

  win.addEventListener(ANNOUNCE, handleAnnounce);
  win.dispatchEvent(new Event(REQUEST));
  onChange(list());

  return {
    current: () => {
      win.dispatchEvent(new Event(REQUEST));
      return list();
    },
    stop: () => win.removeEventListener(ANNOUNCE, handleAnnounce),
  };
}

export type ConnectDecision =
  | { kind: 'none' }
  | { kind: 'choose'; wallets: DiscoveredWallet[] }
  | { kind: 'connect'; wallet: DiscoveredWallet };

/**
 * What Connect should do: tell the user there is no wallet, connect straight
 * to the only one, connect to the one they picked (`chosenId`), or ask
 * them to pick. A `chosenId` that is no longer installed asks again.
 */
export function decideConnect(
  wallets: DiscoveredWallet[],
  chosenId?: string,
): ConnectDecision {
  if (wallets.length === 0) return { kind: 'none' };
  const chosen = chosenId
    ? wallets.find((wallet) => wallet.info.id === chosenId)
    : undefined;
  if (chosen) return { kind: 'connect', wallet: chosen };
  if (wallets.length === 1) return { kind: 'connect', wallet: wallets[0] };
  return { kind: 'choose', wallets };
}

export type ConnectOutcome = 'none' | 'cancelled' | 'connected';

/**
 * Connect as `decideConnect` says. `choose` shows the picker and resolves
 * to the picked wallet's id, or undefined when the user closes it; nothing
 * is sent to any wallet in that case. `connectTo` runs the wallet requests.
 */
export async function connectWallet(
  wallets: DiscoveredWallet[],
  chosenId: string | undefined,
  choose: (wallets: DiscoveredWallet[]) => Promise<string | undefined>,
  connectTo: (wallet: DiscoveredWallet) => Promise<void>,
): Promise<ConnectOutcome> {
  const decision = decideConnect(wallets, chosenId);
  if (decision.kind === 'none') return 'none';
  let wallet: DiscoveredWallet | undefined;
  if (decision.kind === 'connect') {
    wallet = decision.wallet;
  } else {
    const picked = await choose(decision.wallets);
    wallet = decision.wallets.find((option) => option.info.id === picked);
    if (!wallet) return 'cancelled';
  }
  await connectTo(wallet);
  return 'connected';
}
