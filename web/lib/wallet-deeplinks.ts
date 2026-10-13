/**
 * Links that reopen a page inside a phone wallet's own browser. Safari and
 * Chrome on a phone have no wallet extensions, so Connect finds nothing
 * there; the wallet apps' built-in browsers inject a provider and work.
 * Both links are plain https, so a phone without the app lands on that
 * wallet's download page instead of an "invalid address" error.
 *
 * OKX: OKX's "App universal link" guide, since taken down; the last copy
 * is https://web.archive.org/web/20240613082757/https://www.okx.com/zh-hant/web3/build/docs/sdks/app-universal-link
 * The page URL is encoded into an okx:// link, and that whole link is
 * encoded again into OKX's https download link, as the guide's sample does.
 *
 * MetaMask: https://docs.metamask.io/metamask-connect/evm/guides/metamask-exclusive/use-deeplinks/
 * The page goes after /dapp/ unencoded: the app takes that path as it is
 * and puts https:// in front when it has no scheme (handleDappUrl.ts in
 * MetaMask/metamask-mobile), so an encoded URL would break.
 *
 * Neither link works for localhost: test on the deployed https site.
 * Kept free of imports for the node tests.
 */

export function okxWalletLink(pageUrl: string): string {
  const deepLink = `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(pageUrl)}`;
  return `https://www.okx.com/download?deeplink=${encodeURIComponent(deepLink)}`;
}

/** Host, path and query only; a #hash is dropped, since nothing says it survives. */
export function metaMaskLink(pageUrl: string): string {
  const url = new URL(pageUrl);
  return `https://link.metamask.io/dapp/${url.host}${url.pathname}${url.search}`;
}

/** The parts of `navigator` the check reads, so tests can pass a fake. */
export type BrowserNavigator = { userAgent: string; maxTouchPoints: number };

/**
 * An iPhone, iPad or Android device, where the wallet apps exist, tablets
 * included. Deliberately not a "mobile" check: MDN's "Mobi" rule misses tablets, and
 * navigator.userAgentData is missing on every iPhone. Android Chrome's
 * "Desktop site" mode hides "Android", so it reads as a desktop.
 */
export function isWalletAppPlatform(nav: BrowserNavigator): boolean {
  if (/Android|iPhone|iPad|iPod/i.test(nav.userAgent)) return true;
  // iPadOS Safari reports a Mac signature; a real Mac has no touch points.
  return /Macintosh/i.test(nav.userAgent) && nav.maxTouchPoints > 1;
}
