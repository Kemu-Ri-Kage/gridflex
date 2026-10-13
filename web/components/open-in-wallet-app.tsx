'use client';

import { ExternalLink } from 'lucide-react';
import * as React from 'react';

import { useWeb3 } from '@/components/web3-provider';
import {
  isWalletAppPlatform,
  metaMaskLink,
  okxWalletLink,
} from '@/lib/wallet-deeplinks';

function WalletAppLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      className="inline-flex items-center gap-1 font-mono text-foreground underline-offset-4 hover:underline"
      href={href}
      rel="noreferrer"
    >
      {label} <ExternalLink className="size-3" />
    </a>
  );
}

/**
 * On a phone browser with no wallet in it, links that reopen this page in
 * OKX Wallet's or MetaMask's own browser, where Connect works. Renders
 * nothing on a desktop or once a wallet is found. Plain links, built
 * before the tap: iOS only lets a direct tap open another app. The
 * browsers inside chat apps (Telegram, X, Discord) can block that jump,
 * so the page link can also be copied and opened in Safari or Chrome.
 */
export function OpenInWalletApp({ className = '' }: { className?: string }) {
  const { walletDetected, market } = useWeb3();
  const [copied, setCopied] = React.useState(false);
  // walletDetected is undefined on the server and until the provider has
  // mounted, so navigator and location are only read in the browser and
  // the server render and hydration agree. OKApp: OKX's own browser, which
  // can inject its provider late.
  if (
    walletDetected !== false ||
    !isWalletAppPlatform(navigator) ||
    /OKApp/i.test(navigator.userAgent)
  ) {
    return null;
  }
  // Picking another market on /trade changes only page state, not the URL,
  // so the selected market is written into the link here.
  const url = new URL(window.location.href);
  if (market && url.pathname === '/trade')
    url.searchParams.set('market', market);
  const page = url.href;

  const copy = () => {
    void navigator.clipboard?.writeText(page).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <div className={`text-xs leading-5 ${className}`}>
      <p className="text-muted-foreground">
        No wallet in this browser. Open GRIDFLEX in your wallet app:
      </p>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        <WalletAppLink href={okxWalletLink(page)} label="Open in OKX Wallet" />
        <WalletAppLink href={metaMaskLink(page)} label="Open in MetaMask" />
      </div>
      <p className="mt-1 text-muted-foreground">
        Link doesn&apos;t open?{' '}
        <button
          className="font-mono text-foreground underline underline-offset-4"
          onClick={copy}
          type="button"
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>{' '}
        and open it in Safari or Chrome first.
      </p>
    </div>
  );
}
