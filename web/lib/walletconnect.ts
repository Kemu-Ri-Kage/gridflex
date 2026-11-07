/// <reference types="vite/client" />
import type { DiscoveredWallet, WalletInfo, WalletProvider } from './wallet-discovery.ts';

/**
 * WalletConnect: connect a phone wallet app (OKX Wallet, MetaMask, ...) while
 * staying in Safari or Chrome. The app opens only to approve, then the person
 * comes back here, instead of browsing GRIDFLEX inside the wallet's own
 * browser (lib/wallet-deeplinks.ts). On a desktop it shows a QR code to scan
 * with the phone.
 *
 * The project ID comes from cloud.reown.com. It is public by design (every
 * dapp ships it in its page); what limits it is the project's domain
 * allowlist there. Empty switches WalletConnect off everywhere.
 */
export const WALLETCONNECT_PROJECT_ID = '65e4cc7b305f7c9688636805bcaf9ebd';

export const WALLETCONNECT_RDNS = 'com.walletconnect';

export const walletConnectInfo: WalletInfo = {
  id: 'walletconnect',
  name: 'WalletConnect',
  rdns: WALLETCONNECT_RDNS,
};

const X_LAYER_TESTNET = 1952;
const X_LAYER_TESTNET_RPC = 'https://testrpc.xlayer.tech/terigon';

/**
 * The WalletConnect explorer IDs of MetaMask and OKX Wallet, listed first.
 * OKX has two entries, both named "OKX Wallet". This one is the standalone
 * "OKX Wallet: Portal to Web3" app (com.okx.wallet, okxwallet://), the same
 * app lib/wallet-deeplinks.ts opens.
 */
const RECOMMENDED_WALLETS = [
  'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96',
  '5d9f1395b3a8e848684848dc4147cbd05c8d54bb737eac78fe103901fe6b01a1',
];

/**
 * The other "OKX Wallet" entry opens the OKX exchange app (okex://), whose
 * Web3 part is blocked in some regions: in the UK it answered "OKX Web3
 * software services currently aren't available in your region" (7 Nov 2026).
 * Hidden so the list shows one OKX Wallet, the one that works.
 */
const EXCLUDED_WALLETS = ['971e689d0a5be527bac79629b4ee9b925e82208e5168b733496a09c0faed0709'];

/** Requests the wallet app has to show the person: each needs a trip to it. */
const APPROVAL_METHODS = new Set([
  'eth_sendTransaction',
  'eth_signTransaction',
  'eth_sign',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'wallet_watchAsset',
]);

export const CLOSED_MESSAGE =
  'Closed before a wallet connected. Try again, or open GRIDFLEX inside your wallet app.';

export function walletConnectAvailable(projectId = WALLETCONNECT_PROJECT_ID): boolean {
  return projectId.trim().length > 0;
}

/**
 * Where the library keeps its sessions in a browser: an IndexedDB database,
 * not localStorage (@walletconnect/keyvaluestorage, src/browser).
 */
const SESSION_DB = 'WALLET_CONNECT_V2_INDEXED_DB';
const SESSION_STORE = 'keyvaluestorage';

/**
 * True when these stored entries hold a WalletConnect session: the library
 * keeps them under "wc@2:client:<version>//session" as a JSON array, and its
 * IndexedDB store turns the slashes into one colon ("wc@2:client:0.3:session").
 */
export function hasStoredSession(entries: Iterable<[string, unknown]>): boolean {
  for (const [key, value] of entries) {
    if (!/^wc@2:client:.*(:|\/\/)session$/.test(key)) continue;
    try {
      const sessions = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
      if (Array.isArray(sessions) && sessions.length > 0) return true;
    } catch {
      // Unreadable: not a session.
    }
  }
  return false;
}

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * The library's stored entries, read without loading it: so a page load
 * only fetches it when there is a session to restore. Never creates the
 * database: the library makes its store only when it creates the database
 * itself, so an empty one left here would break it.
 */
async function storedEntries(idb = pageIndexedDb()): Promise<[string, unknown][]> {
  if (!idb) return [];
  try {
    if (typeof idb.databases === 'function') {
      const names = (await idb.databases()).map((database) => database.name);
      if (!names.includes(SESSION_DB)) return [];
    }
    const request = idb.open(SESSION_DB);
    // Runs only when the database is missing: aborting leaves none behind.
    request.onupgradeneeded = () => request.transaction?.abort();
    const db = await settled(request);
    try {
      if (!db.objectStoreNames.contains(SESSION_STORE)) return [];
      const store = db.transaction(SESSION_STORE, 'readonly').objectStore(SESSION_STORE);
      const [keys, values] = await Promise.all([settled(store.getAllKeys()), settled(store.getAll())]);
      return keys.flatMap((key, i): [string, unknown][] =>
        typeof key === 'string' ? [[key, values[i] as unknown]] : [],
      );
    } finally {
      db.close();
    }
  } catch {
    // Storage refused or unreadable: nothing to restore.
    return [];
  }
}

type PeerMetadata = {
  name?: string;
  redirect?: { native?: string; universal?: string };
};

export type Approval = {
  /** The connected wallet app, e.g. "OKX Wallet". */
  wallet: string;
  /** A link that opens it, when it published one. */
  link?: string;
};

/** The link that brings the wallet app forward: its https link first, which iOS prefers. */
export function walletAppLink(metadata: PeerMetadata | undefined): string | undefined {
  const link = metadata?.redirect?.universal || metadata?.redirect?.native;
  return link && /^[a-z][a-z0-9+.-]*:/i.test(link) && !/^javascript:/i.test(link) ? link : undefined;
}

/**
 * The request waiting for the person in their wallet app, if any, for
 * WalletApproval to show "Approve in OKX Wallet". A plain store, so the
 * provider wrapper can update it outside React.
 */
export function approvalStore() {
  let current: Approval | null = null;
  let waiting = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    begin: (approval: Approval) => {
      waiting += 1;
      current = approval;
      emit();
    },
    end: () => {
      waiting = Math.max(0, waiting - 1);
      if (waiting === 0 && current) {
        current = null;
        emit();
      }
    },
    snapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const approvals = approvalStore();

type EthereumProvider = Awaited<
  ReturnType<(typeof import('@walletconnect/ethereum-provider'))['EthereumProvider']['init']>
>;

/**
 * Wraps the WalletConnect provider in the shape every other wallet has:
 * eth_requestAccounts opens the WalletConnect sheet (enable() pairs first
 * when there is no session), and each request that needs the wallet app
 * shows the approval prompt while it waits.
 */
export function wrapProvider(
  provider: Pick<EthereumProvider, 'request' | 'enable' | 'on' | 'removeListener'> & {
    session?: { peer?: { metadata?: PeerMetadata } };
  },
  store = approvals,
): WalletProvider {
  return {
    async request(args) {
      if (args.method === 'eth_requestAccounts') {
        try {
          return await provider.enable();
        } catch (error) {
          // The library's words for "the sheet was closed".
          if (error instanceof Error && /request reset/i.test(error.message)) {
            throw new Error(CLOSED_MESSAGE);
          }
          throw error;
        }
      }
      if (!APPROVAL_METHODS.has(args.method)) {
        return provider.request(args as Parameters<EthereumProvider['request']>[0]);
      }
      const metadata = provider.session?.peer?.metadata;
      store.begin({ wallet: metadata?.name || 'your wallet app', link: walletAppLink(metadata) });
      try {
        return await provider.request(args as Parameters<EthereumProvider['request']>[0]);
      } finally {
        store.end();
      }
    },
    on: (event, listener) => {
      provider.on(event as never, listener as never);
    },
    removeListener: (event, listener) => {
      provider.removeListener(event as never, listener as never);
    },
  };
}

let shared: Promise<EthereumProvider> | undefined;

/**
 * The library, in the browser only. Vite sets import.meta.env.SSR to a
 * constant per build, so the server build drops this import (and the
 * megabyte behind it) entirely.
 */
const importLibrary = () =>
  import.meta.env.SSR
    ? Promise.reject(new Error('WalletConnect runs in the browser only.'))
    : import('@walletconnect/ethereum-provider');

/** One provider per page, loaded only when first asked for. */
function load(): Promise<EthereumProvider> {
  shared ??= importLibrary()
    .then(({ EthereumProvider }) =>
      EthereumProvider.init({
        projectId: WALLETCONNECT_PROJECT_ID,
        optionalChains: [X_LAYER_TESTNET],
        rpcMap: { [X_LAYER_TESTNET]: X_LAYER_TESTNET_RPC },
        showQrModal: true,
        qrModalOptions: {
          themeMode: 'dark',
          explorerRecommendedWalletIds: RECOMMENDED_WALLETS,
          explorerExcludedWalletIds: EXCLUDED_WALLETS,
        },
        metadata: {
          name: 'GRIDFLEX',
          description: 'Cash-settled contracts on the Texas power price, on X Layer.',
          url: window.location.origin,
          icons: [`${window.location.origin}/favicon.svg`],
        },
      }),
    )
    .catch((error: unknown) => {
      shared = undefined;
      throw error;
    });
  return shared;
}

/** WalletConnect as a wallet like any other, for Web3Provider's connectTo. */
export async function walletConnectWallet(): Promise<DiscoveredWallet> {
  return { info: walletConnectInfo, provider: wrapProvider(await load()) };
}

function pageIndexedDb(): IDBFactory | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.indexedDB;
  } catch {
    return undefined;
  }
}

/**
 * The wallet from a session saved by an earlier visit, or undefined.
 * `connectedBefore`: this browser remembers connecting with WalletConnect,
 * so the library is worth loading without looking for a session first.
 */
export async function restoreWalletConnect(
  connectedBefore = false,
): Promise<DiscoveredWallet | undefined> {
  if (!walletConnectAvailable()) return undefined;
  if (!connectedBefore && !hasStoredSession(await storedEntries())) return undefined;
  try {
    const provider = await load();
    return provider.session ? { info: walletConnectInfo, provider: wrapProvider(provider) } : undefined;
  } catch {
    return undefined;
  }
}

/** Ends the session in the wallet app too. Never throws. */
export async function disconnectWalletConnect(): Promise<void> {
  if (!shared) return;
  try {
    await (await shared).disconnect();
  } catch {
    // Already gone, or the relay is unreachable: nothing left to end here.
  }
}
