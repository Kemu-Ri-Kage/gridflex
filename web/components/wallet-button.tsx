'use client';

import { ExternalLink, LogOut, Wallet } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useWeb3 } from '@/components/web3-provider';

/** OKX's Web3 portal: the wallet download for every platform. */
const OKX_WALLET_URL = 'https://www.okx.com/web3';

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Header wallet control. Connection failures are surfaced here, under the
 * button, because nothing else on the page shows them: the order ticket
 * only shows trade errors, and on a closed market there is no ticket.
 */
export function WalletButton() {
  const {
    account,
    connect,
    disconnect,
    pendingAction,
    connectError,
    walletDetected,
  } = useWeb3();

  if (account) {
    return (
      <Button
        aria-label="Disconnect wallet"
        className="h-8 rounded-[2px] border-border bg-background px-3 font-mono text-foreground shadow-none hover:bg-muted"
        onClick={disconnect}
        variant="outline"
      >
        <span className="size-1.5 rounded-full bg-up" />
        {shortAddress(account)}
        <LogOut className="ml-1 size-3.5 text-muted-foreground" />
      </Button>
    );
  }

  return (
    <div className="relative">
      <Button
        className="h-8 rounded-[2px] bg-primary px-4 text-primary-foreground shadow-none hover:bg-primary/85"
        disabled={Boolean(pendingAction)}
        onClick={() => void connect()}
      >
        <Wallet data-icon="inline-start" />
        Connect wallet
      </Button>
      {connectError && (
        <div
          aria-live="polite"
          className="absolute right-0 top-full z-20 mt-2 w-[min(18rem,calc(100vw-2rem))] border border-border bg-card p-3 text-xs leading-5 shadow-none"
        >
          <p className="text-down">{connectError}</p>
          {walletDetected === false && (
            <a
              className="mt-2 inline-flex items-center gap-1 font-mono text-foreground underline-offset-4 hover:underline"
              href={OKX_WALLET_URL}
              rel="noreferrer"
              target="_blank"
            >
              Install OKX Wallet <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}
