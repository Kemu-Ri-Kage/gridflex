'use client';

import { Dialog } from '@base-ui/react/dialog';
import { Wallet } from 'lucide-react';

import { useWeb3 } from '@/components/web3-provider';

/** Only an image data: URI from the announcement is drawn, and only via <img>. */
function safeIcon(icon?: string) {
  return icon && /^data:image\/(png|svg\+xml|webp|jpeg|gif);/i.test(icon)
    ? icon
    : undefined;
}

/**
 * Shown when Connect finds more than one wallet (lib/wallet-discovery.ts):
 * each installed wallet by the name and icon it announced. Closing it
 * cancels the connect; nothing is sent to any wallet until one is picked.
 * Built on the Base UI primitives rather than ui/dialog, whose backdrop
 * blur and open/close animation the terminal doesn't allow (design brief
 * §2, §13).
 */
export function WalletPicker() {
  const { walletChoices, chooseWallet } = useWeb3();

  return (
    <Dialog.Root
      onOpenChange={(open) => {
        if (!open) chooseWallet(undefined);
      }}
      open={Boolean(walletChoices)}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-xs -translate-x-1/2 -translate-y-1/2 gap-3 rounded-[2px] border border-border bg-card p-4 text-sm text-foreground outline-none">
          <Dialog.Title className="text-sm font-semibold">
            Choose a wallet
          </Dialog.Title>
          <ul className="flex flex-col gap-2">
            {walletChoices?.map((option) => {
              const icon = safeIcon(option.icon);
              return (
                <li key={option.id}>
                  <button
                    className="flex h-10 w-full items-center gap-3 rounded-[2px] border border-border bg-background px-3 text-left text-sm text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() => chooseWallet(option.id)}
                    type="button"
                  >
                    {icon ? (
                      // oxlint-disable-next-line next/no-img-element -- the wallet's own data: URI, nothing to optimise
                      <img
                        alt=""
                        className="size-5 shrink-0"
                        height={20}
                        src={icon}
                        width={20}
                      />
                    ) : (
                      <Wallet className="size-5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 truncate">{option.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            className="h-8 rounded-[2px] border border-border px-3 text-xs text-muted-foreground hover:bg-muted"
            onClick={() => chooseWallet(undefined)}
            type="button"
          >
            Cancel
          </button>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
