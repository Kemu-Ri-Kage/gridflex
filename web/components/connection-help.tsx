'use client';

import * as React from 'react';
import { ChevronDown, Copy } from 'lucide-react';

import { XLAYER_TESTNET_RPC_URLS } from '@/lib/contracts';

function CopyableUrl({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="mt-1 flex items-center gap-2">
      <code className="min-w-0 flex-1 break-all rounded-[2px] border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground">
        {url}
      </code>
      <button
        aria-label={`Copy ${label} RPC URL`}
        className="inline-flex shrink-0 items-center gap-1 rounded-[2px] border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(url)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
        type="button"
      >
        <Copy className="size-3" /> {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/**
 * Shown when a wallet request fails in a way that points at the wallet's
 * own saved RPC for X Layer (lib/wallet-errors.ts). A wallet sends
 * transactions through the network it already has saved, which this site
 * can neither see nor change, so this only explains how to replace the RPC
 * by hand.
 */
export function ConnectionHelp() {
  const [open, setOpen] = React.useState(false);
  const [primary, backup] = XLAYER_TESTNET_RPC_URLS;

  return (
    <div className="rounded-[2px] border border-warning/40 bg-warning/10 text-xs">
      <button
        aria-controls="xlayer-connection-help"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left font-semibold text-warning"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        X Layer connection help
        <ChevronDown
          className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div
          className="space-y-2 border-t border-warning/30 px-3 py-3 leading-5 text-foreground"
          id="xlayer-connection-help"
        >
          <p>
            Your wallet sends transactions through the RPC address it has saved
            for X Layer Testnet, and that address didn&apos;t respond. This site
            can&apos;t see or change a network your wallet already has saved.
            You can replace the RPC yourself in MetaMask:
          </p>
          <ol className="list-decimal space-y-1 pl-4">
            <li>
              Open MetaMask, open the network menu, and find X Layer Testnet
              (chain ID 1952). Choose Edit.
            </li>
            <li>
              Under Default RPC URL, choose Add RPC URL and paste:
              <CopyableUrl label="primary" url={primary} />
              <span className="mt-1 block text-muted-foreground">
                If that one fails too, use the backup:
              </span>
              <CopyableUrl label="backup" url={backup} />
            </li>
            <li>Select the new URL as the default and save.</li>
            <li>Come back here and try again.</li>
          </ol>
          <p className="text-muted-foreground">
            Other wallets have the same setting under their network or chain
            settings.
          </p>
        </div>
      )}
    </div>
  );
}
