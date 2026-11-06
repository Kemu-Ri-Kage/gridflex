'use client';

import { ExternalLink } from 'lucide-react';
import * as React from 'react';

import { useWeb3 } from '@/components/web3-provider';
import {
  isWalletAppPlatform,
  metaMaskLink,
  okxWalletLink,
} from '@/lib/wallet-deeplinks';

function WalletAppButton({ href, label }: { href: string; label: string }) {
  return (
    <a
      className="flex h-10 w-full items-center justify-between rounded-[2px] border border-border bg-background px-3 font-mono text-sm text-foreground hover:bg-muted"
      href={href}
      rel="noreferrer"
    >
      {label} <ExternalLink className="size-3.5 text-muted-foreground" />
    </a>
  );
}

/**
 * True on a phone browser with no wallet in it: the case where Connect can't
 * work here and the wallet app's own browser can. False on the server and
 * until the provider has looked for wallets (walletDetected is undefined
 * then), on a desktop, and inside OKX's own browser, which can inject its
 * provider late. Callers use it to show OpenInWalletApp instead of a
 * "no wallet found" error.
 */
export function useNeedsWalletApp(): boolean {
  const { walletDetected } = useWeb3();
  if (walletDetected !== false || typeof navigator === 'undefined') return false;
  return isWalletAppPlatform(navigator) && !/OKApp/i.test(navigator.userAgent);
}

/**
 * On a phone browser with no wallet in it: open this page in OKX Wallet's or
 * MetaMask's own browser, where Connect, the network switch and every
 * signature work in place. Each button opens the app when it's installed
 * and its download page when it isn't, so one tap covers both. Plain links,
 * built before the tap: iOS only lets a direct tap open another app. The
 * browsers inside chat apps (Telegram, X, Discord) can block that jump, so
 * the page link can also be copied and opened in Safari or Chrome.
 * Renders nothing anywhere else.
 */
export function OpenInWalletApp({ className = '' }: { className?: string }) {
  const { market } = useWeb3();
  const needed = useNeedsWalletApp();
  const [copied, setCopied] = React.useState(false);
  if (!needed) return null;

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
    <div className={`flex flex-col gap-2 text-xs leading-5 ${className}`}>
      <div>
        <p className="font-medium text-foreground">
          Connect with your wallet app
        </p>
        <p className="text-muted-foreground">
          Phone browsers have no wallet built in. Open GRIDFLEX inside your
          wallet app, then tap Connect there.
        </p>
      </div>
      <WalletAppButton href={okxWalletLink(page)} label="Open in OKX Wallet" />
      <WalletAppButton href={metaMaskLink(page)} label="Open in MetaMask" />
      <p className="text-muted-foreground">
        No wallet app yet? The same button takes you to download it.
      </p>
      <p className="text-muted-foreground">
        Nothing opens?{' '}
        <button
          className="font-mono text-foreground underline underline-offset-4"
          onClick={copy}
          type="button"
        >
          {copied ? 'Link copied' : 'Copy link'}
        </button>{' '}
        and paste it into Safari or Chrome first.
      </p>
    </div>
  );
}
