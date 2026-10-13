import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isWalletAppPlatform,
  metaMaskLink,
  okxWalletLink,
} from './wallet-deeplinks.ts';

// A market page as the landing page's contract cards link to it.
const PAGE =
  'https://gridflex-web.teslenko-platon.workers.dev/trade?market=0xb22A449cdEfA3C4D226Ff69fd87d95f4FaadE604';

void test('the OKX link encodes the page into okx://, then encodes that link again', () => {
  assert.equal(
    okxWalletLink(PAGE),
    'https://www.okx.com/download?deeplink=' +
      'okx%3A%2F%2Fwallet%2Fdapp%2Furl%3FdappUrl%3D' +
      'https%253A%252F%252Fgridflex-web.teslenko-platon.workers.dev' +
      '%252Ftrade%253Fmarket%253D0xb22A449cdEfA3C4D226Ff69fd87d95f4FaadE604',
  );
});

void test('the OKX link gives back the exact page, even with &, + and % in it', () => {
  const page = `${PAGE}&note=a+b%20c#ticket`;
  const deepLink =
    new URL(okxWalletLink(page)).searchParams.get('deeplink') ?? '';
  assert.ok(deepLink.startsWith('okx://wallet/dapp/url?dappUrl='));
  // Nothing in the page's own query leaks into either link's parameters.
  const params = new URL(deepLink).searchParams;
  assert.deepEqual([...params.keys()], ['dappUrl']);
  assert.equal(params.get('dappUrl'), page);
});

void test('the MetaMask link puts the page after /dapp/ unencoded, query kept', () => {
  assert.equal(
    metaMaskLink(PAGE),
    'https://link.metamask.io/dapp/gridflex-web.teslenko-platon.workers.dev/trade?market=0xb22A449cdEfA3C4D226Ff69fd87d95f4FaadE604',
  );
});

void test('the MetaMask link drops the scheme and any #hash', () => {
  assert.equal(
    metaMaskLink(
      'https://gridflex-web.teslenko-platon.workers.dev/#how-it-works',
    ),
    'https://link.metamask.io/dapp/gridflex-web.teslenko-platon.workers.dev/',
  );
  assert.doesNotMatch(metaMaskLink(PAGE), /%3A|https:\/\/gridflex/);
});

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
// Android tablets send no "Mobile", but can run the wallet apps.
const ANDROID_TABLET =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
// iPadOS Safari and Mac Safari send the same signature.
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

void test('iPhones, iPads and Android phones and tablets count as mobile', () => {
  assert.equal(
    isWalletAppPlatform({ userAgent: IPHONE_SAFARI, maxTouchPoints: 5 }),
    true,
  );
  assert.equal(
    isWalletAppPlatform({ userAgent: ANDROID_CHROME, maxTouchPoints: 5 }),
    true,
  );
  assert.equal(
    isWalletAppPlatform({ userAgent: ANDROID_TABLET, maxTouchPoints: 10 }),
    true,
  );
  assert.equal(
    isWalletAppPlatform({ userAgent: MAC_SAFARI, maxTouchPoints: 5 }),
    true,
  );
});

void test('Macs and touchscreen Windows laptops do not', () => {
  assert.equal(
    isWalletAppPlatform({ userAgent: MAC_SAFARI, maxTouchPoints: 0 }),
    false,
  );
  assert.equal(
    isWalletAppPlatform({ userAgent: WINDOWS_CHROME, maxTouchPoints: 10 }),
    false,
  );
  assert.equal(
    isWalletAppPlatform({ userAgent: '', maxTouchPoints: 0 }),
    false,
  );
});
