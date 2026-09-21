'use client';

import { LogOut, Wallet } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useWeb3 } from '@/components/web3-provider';

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletButton() {
  const { account, connect, disconnect, pendingAction } = useWeb3();

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
    <Button
      className="h-8 rounded-[2px] bg-primary px-4 text-primary-foreground shadow-none hover:bg-primary/85"
      disabled={Boolean(pendingAction)}
      onClick={() => void connect()}
    >
      <Wallet data-icon="inline-start" />
      Connect wallet
    </Button>
  );
}
