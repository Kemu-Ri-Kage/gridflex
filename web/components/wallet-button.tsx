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
        className="h-9 border-white/10 bg-white/5 px-3 font-mono text-slate-200 hover:bg-white/10"
        onClick={disconnect}
        variant="outline"
      >
        <span className="size-1.5 rounded-full bg-[#a8ff3e]" />
        {shortAddress(account)}
        <LogOut className="ml-1 size-3.5 text-slate-500" />
      </Button>
    );
  }

  return (
    <Button
      className="h-9 bg-[#a8ff3e] px-4 text-[#061008] hover:bg-[#bdff6c]"
      disabled={Boolean(pendingAction)}
      onClick={() => void connect()}
    >
      <Wallet data-icon="inline-start" />
      Connect wallet
    </Button>
  );
}
