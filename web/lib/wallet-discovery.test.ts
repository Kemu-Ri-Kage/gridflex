import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  connectWallet,
  decideConnect,
  OKX_RDNS,
  watchWallets,
  type DiscoveredWallet,
  type DiscoveryWindow,
  type WalletProvider,
} from './wallet-discovery.ts';

type FakeProvider = WalletProvider & { methods: string[] };

function fakeProvider(flags: Partial<WalletProvider> = {}): FakeProvider {
  const methods: string[] = [];
  return {
    ...flags,
    methods,
    request: async ({ method }) => {
      methods.push(method);
      return ['0x1111111111111111111111111111111111111111'];
    },
  };
}

type FakeWallet = {
  uuid: string;
  name: string;
  rdns: string;
  provider: FakeProvider;
};

/**
 * A window whose wallets answer every eip6963:requestProvider, as the
 * extensions do, plus whatever legacy globals the test sets.
 */
function fakeWindow(
  wallets: FakeWallet[] = [],
  globals: Pick<DiscoveryWindow, 'okxwallet' | 'ethereum'> = {},
): DiscoveryWindow & { announceLate: (wallet: FakeWallet) => void } {
  const target = new EventTarget();
  const announce = (wallet: FakeWallet) =>
    target.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: {
          info: {
            uuid: wallet.uuid,
            name: wallet.name,
            icon: 'data:image/svg+xml;base64,AA==',
            rdns: wallet.rdns,
          },
          provider: wallet.provider,
        },
      }),
    );
  target.addEventListener('eip6963:requestProvider', () =>
    wallets.forEach(announce),
  );
  return {
    addEventListener: (type, listener) =>
      target.addEventListener(type, listener),
    removeEventListener: (type, listener) =>
      target.removeEventListener(type, listener),
    dispatchEvent: (event) => target.dispatchEvent(event),
    ...globals,
    announceLate: announce,
  };
}

const okx = (): FakeWallet => ({
  uuid: 'okx-uuid',
  name: 'OKX Wallet',
  rdns: OKX_RDNS,
  provider: fakeProvider({ isOkxWallet: true }),
});
const metaMask = (): FakeWallet => ({
  uuid: 'metamask-uuid',
  name: 'MetaMask',
  rdns: 'io.metamask',
  provider: fakeProvider(),
});

function discover(win: DiscoveryWindow): DiscoveredWallet[] {
  const watcher = watchWallets(win, () => {});
  const wallets = watcher.current();
  watcher.stop();
  return wallets;
}

const names = (wallets: DiscoveredWallet[]) =>
  wallets.map((wallet) => wallet.info.name);

void test('two announced wallets are both offered, OKX Wallet first', () => {
  const mm = metaMask();
  const ok = okx();
  // window.ethereum is MetaMask's, as measured in Chrome with both installed;
  // it must not decide which wallet connects.
  const wallets = discover(fakeWindow([mm, ok], { ethereum: mm.provider }));
  assert.deepEqual(names(wallets), ['OKX Wallet', 'MetaMask']);
  assert.equal(wallets[0].info.icon, 'data:image/svg+xml;base64,AA==');
  assert.equal(decideConnect(wallets).kind, 'choose');
});

void test('two wallets: the picked one connects, the other is never asked', async () => {
  const mm = metaMask();
  const ok = okx();
  const wallets = discover(fakeWindow([mm, ok]));
  const offered: string[][] = [];
  const connected: string[] = [];
  const outcome = await connectWallet(
    wallets,
    undefined,
    async (options) => {
      offered.push(names(options));
      return 'okx-uuid';
    },
    async (wallet) => {
      connected.push(wallet.info.name);
      await wallet.provider.request({ method: 'eth_requestAccounts' });
    },
  );
  assert.equal(outcome, 'connected');
  assert.deepEqual(offered, [['OKX Wallet', 'MetaMask']]);
  assert.deepEqual(connected, ['OKX Wallet']);
  assert.deepEqual(ok.provider.methods, ['eth_requestAccounts']);
  assert.deepEqual(mm.provider.methods, []);
});

void test('the wallet picked earlier this session connects without asking again', async () => {
  const wallets = discover(fakeWindow([metaMask(), okx()]));
  let asked = false;
  const outcome = await connectWallet(
    wallets,
    'metamask-uuid',
    async () => {
      asked = true;
      return undefined;
    },
    async () => {},
  );
  assert.equal(outcome, 'connected');
  assert.equal(asked, false);
});

void test('a remembered wallet that is no longer installed asks again', () => {
  const wallets = discover(fakeWindow([metaMask(), okx()]));
  assert.equal(decideConnect(wallets, 'uninstalled-uuid').kind, 'choose');
});

void test('one announced wallet connects straight away, no picker', async () => {
  const ok = okx();
  const wallets = discover(fakeWindow([ok]));
  assert.deepEqual(names(wallets), ['OKX Wallet']);
  let asked = false;
  const outcome = await connectWallet(
    wallets,
    undefined,
    async () => {
      asked = true;
      return undefined;
    },
    (wallet) =>
      wallet.provider.request({ method: 'eth_requestAccounts' }).then(() => {}),
  );
  assert.equal(outcome, 'connected');
  assert.equal(asked, false);
  assert.deepEqual(ok.provider.methods, ['eth_requestAccounts']);
});

void test('no wallet found says so and sends nothing', async () => {
  const wallets = discover(fakeWindow());
  assert.deepEqual(wallets, []);
  let connected = false;
  const outcome = await connectWallet(
    wallets,
    undefined,
    async () => undefined,
    async () => {
      connected = true;
    },
  );
  assert.equal(outcome, 'none');
  assert.equal(connected, false);
});

void test('an older OKX Wallet with no announcement is found through window.okxwallet', () => {
  const provider = fakeProvider({ isOkxWallet: true });
  // As in OKX's in-app browser and older builds: the same provider on both
  // globals is one wallet, not two.
  const wallets = discover(
    fakeWindow([], { okxwallet: provider, ethereum: provider }),
  );
  assert.deepEqual(names(wallets), ['OKX Wallet']);
  assert.equal(wallets[0].info.rdns, OKX_RDNS);
  assert.equal(decideConnect(wallets).kind, 'connect');
});

void test('an older wallet on window.ethereum only is found, without assuming MetaMask', () => {
  const wallets = discover(
    fakeWindow([], { ethereum: fakeProvider({ isOkxWallet: false }) }),
  );
  assert.deepEqual(names(wallets), ['Browser wallet']);
  assert.equal(wallets[0].info.rdns, undefined);
});

void test('two older wallets on separate globals are both offered', () => {
  const wallets = discover(
    fakeWindow([], {
      okxwallet: fakeProvider({ isOkxWallet: true }),
      ethereum: fakeProvider(),
    }),
  );
  assert.deepEqual(names(wallets), ['OKX Wallet', 'Browser wallet']);
  assert.equal(decideConnect(wallets).kind, 'choose');
});

void test('once any wallet announces, the legacy globals are not listed again', () => {
  const ok = okx();
  const wallets = discover(
    fakeWindow([ok], { okxwallet: fakeProvider(), ethereum: fakeProvider() }),
  );
  assert.deepEqual(names(wallets), ['OKX Wallet']);
});

void test('a wallet that announces late is picked up', () => {
  const win = fakeWindow();
  const seen: string[][] = [];
  const watcher = watchWallets(win, (wallets) => seen.push(names(wallets)));
  win.announceLate(okx());
  assert.deepEqual(seen, [[], ['OKX Wallet']]);
  assert.deepEqual(names(watcher.current()), ['OKX Wallet']);
  watcher.stop();
});

void test('cancelling the picker connects nothing and asks again next time', async () => {
  const mm = metaMask();
  const ok = okx();
  const wallets = discover(fakeWindow([mm, ok]));
  let connected = false;
  const outcome = await connectWallet(
    wallets,
    undefined,
    async () => undefined,
    async () => {
      connected = true;
    },
  );
  assert.equal(outcome, 'cancelled');
  assert.equal(connected, false);
  assert.deepEqual(ok.provider.methods, []);
  assert.deepEqual(mm.provider.methods, []);
  assert.equal(decideConnect(wallets).kind, 'choose');
});

void test('an announcement without a provider is ignored', () => {
  const win = fakeWindow();
  const watcher = watchWallets(win, () => {});
  win.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid: 'x', name: 'Broken' } },
    }),
  );
  assert.deepEqual(watcher.current(), []);
  watcher.stop();
});
