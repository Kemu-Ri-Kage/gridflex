'use client';

import { ExternalLink } from 'lucide-react';
import * as React from 'react';

import { isWalletAppPlatform } from '@/lib/wallet-deeplinks';
import { approvals } from '@/lib/walletconnect';

/**
 * While a WalletConnect request waits in the wallet app (lib/walletconnect.ts):
 * say where to approve it and, on a phone, link straight to the app. iOS
 * only opens another app from a tap, so this is a button, not a redirect.
 * Mounted once, inside the Web3 provider; renders nothing otherwise.
 */
export function WalletApproval() {
  const approval = React.useSyncExternalStore(
    approvals.subscribe,
    approvals.snapshot,
    () => null,
  );
  if (!approval) return null;
  const phone = isWalletAppPlatform(navigator);

  return (
    <div
      aria-live="polite"
      className="fixed inset-x-3 bottom-24 z-50 mx-auto flex max-w-sm items-center justify-between gap-3 border border-border bg-card p-3 text-xs leading-5 lg:bottom-6"
    >
      <p className="text-foreground">
        {phone
          ? `Approve in ${approval.wallet}, then come back to this page.`
          : `Approve on your phone, in ${approval.wallet}.`}
      </p>
      {phone && approval.link && (
        <a
          className="inline-flex shrink-0 items-center gap-1 rounded-[2px] bg-primary px-3 py-2 font-mono text-primary-foreground"
          href={approval.link}
          rel="noreferrer"
        >
          Open <ExternalLink className="size-3" />
        </a>
      )}
    </div>
  );
}
