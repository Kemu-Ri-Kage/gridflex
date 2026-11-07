import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  approvalStore,
  hasStoredSession,
  walletAppLink,
  walletConnectAvailable,
  wrapProvider,
} from './walletconnect.ts';

void test('WalletConnect is off until a project ID is set', () => {
  assert.equal(walletConnectAvailable(''), false);
  assert.equal(walletConnectAvailable('  '), false);
  assert.equal(walletConnectAvailable('a1b2c3'), true);
});

void test('a stored session is found without loading the library', () => {
  const key = 'wc@2:client:0.3//session';
  assert.equal(hasStoredSession([]), false);
  assert.equal(hasStoredSession([[key, '[]']]), false);
  assert.equal(hasStoredSession([[key, '[{"topic":"t"}]']]), true);
  assert.equal(hasStoredSession([[key, [{ topic: 't' }]]]), true);
  assert.equal(hasStoredSession([[key, 'not json']]), false);
  assert.equal(hasStoredSession([['other//session', '[{"topic":"t"}]']]), false);
  assert.equal(hasStoredSession([['wc_storage_version', 1], [key, '[{"topic":"t"}]']]), true);
  // As IndexedDB stores the key.
  assert.equal(hasStoredSession([['wc@2:client:0.3:session', '[{"topic":"t"}]']]), true);
  assert.equal(hasStoredSession([['wc@2:client:0.3:session', '[]']]), false);
  assert.equal(hasStoredSession([['wc@2:client:0.3:proposal', '[{"id":1}]']]), false);
});

void test('the wallet app link prefers the https link and refuses script links', () => {
  assert.equal(
    walletAppLink({ redirect: { native: 'okx://', universal: 'https://web3.okx.com/wc' } }),
    'https://web3.okx.com/wc',
  );
  assert.equal(walletAppLink({ redirect: { native: 'metamask://' } }), 'metamask://');
  assert.equal(walletAppLink({ redirect: { native: 'javascript:alert(1)' } }), undefined);
  assert.equal(walletAppLink({ redirect: { native: 'no-scheme' } }), undefined);
  assert.equal(walletAppLink(undefined), undefined);
});

void test('the approval prompt shows while any request waits in the wallet app', () => {
  const store = approvalStore();
  let calls = 0;
  store.subscribe(() => calls++);
  assert.equal(store.snapshot(), null);
  store.begin({ wallet: 'OKX Wallet' });
  store.begin({ wallet: 'OKX Wallet' });
  store.end();
  assert.deepEqual(store.snapshot(), { wallet: 'OKX Wallet' });
  store.end();
  assert.equal(store.snapshot(), null);
  store.end();
  assert.equal(store.snapshot(), null);
  assert.equal(calls, 3);
});

function fakeProvider() {
  const seen: string[] = [];
  let release: (() => void) | undefined;
  const provider = {
    session: {
      peer: { metadata: { name: 'OKX Wallet', redirect: { universal: 'https://web3.okx.com/wc' } } },
    },
    enable: () => {
      seen.push('enable');
      return Promise.resolve(['0xabc']);
    },
    request: (args: { method: string }) => {
      seen.push(args.method);
      if (args.method !== 'eth_sendTransaction') return Promise.resolve('0x1');
      return new Promise<string>((resolve) => {
        release = () => resolve('0xhash');
      });
    },
    on: () => undefined,
    removeListener: () => undefined,
  };
  return { provider, seen, release: () => release?.() };
}

void test('asking for accounts pairs through enable(), like any wallet’s connect', async () => {
  const { provider, seen } = fakeProvider();
  const wrapped = wrapProvider(provider as never, approvalStore());
  assert.deepEqual(await wrapped.request({ method: 'eth_requestAccounts' }), ['0xabc']);
  assert.deepEqual(seen, ['enable']);
});

void test('a transaction shows “approve in OKX Wallet” until the wallet answers', async () => {
  const { provider, release } = fakeProvider();
  const store = approvalStore();
  const wrapped = wrapProvider(provider as never, store);

  assert.equal(await wrapped.request({ method: 'eth_chainId' }), '0x1');
  assert.equal(store.snapshot(), null);

  const sent = wrapped.request({ method: 'eth_sendTransaction', params: [{}] });
  assert.deepEqual(store.snapshot(), { wallet: 'OKX Wallet', link: 'https://web3.okx.com/wc' });
  release();
  assert.equal(await sent, '0xhash');
  assert.equal(store.snapshot(), null);
});
