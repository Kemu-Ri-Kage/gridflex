'use client';

import * as React from 'react';
import { ChevronDown, Copy } from 'lucide-react';

import { useWeb3 } from '@/components/web3-provider';
import { XLAYER_TESTNET_RPC_URLS } from '@/lib/contracts';
import { METAMASK_RDNS } from '@/lib/wallet-discovery';

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

/** How long Connect waits on the wallet before suggesting its window never opened. */
export const PROMPT_HINT_DELAY_MS = 8000;

/** The Connect buttons: the header's, on every page, and the order ticket's on /trade. */
export type ConnectOrigin = 'header' | 'ticket';

// Which button started the connect in progress, so its hint shows under
// that button only, never under both. Set in the click handler, before
// `connecting` flips and the hints re-render.
let connectOrigin: ConnectOrigin | undefined;

/** A Connect button's click handler, noting which button it was. */
export function useConnectFrom(origin: ConnectOrigin): () => void {
  const { connect } = useWeb3();
  return React.useCallback(() => {
    connectOrigin = origin;
    void connect();
  }, [connect, origin]);
}

/**
 * Shown under the Connect button that has read "Check your wallet…" for
 * PROMPT_HINT_DELAY_MS. Some embedded browsers (the in-app browser of a
 * chat app, for one) pass the request to the wallet but never surface its
 * window, so the request just waits; the same page works in a normal
 * browser with the extension installed.
 */
export function WalletPromptHint({ origin, className = '' }: { origin: ConnectOrigin; className?: string }) {
  const { connecting, wallet } = useWeb3();
  const [late, setLate] = React.useState(false);

  React.useEffect(() => {
    if (!connecting) return;
    const timer = window.setTimeout(() => setLate(true), PROMPT_HINT_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      setLate(false);
    };
  }, [connecting]);

  if (!connecting || !late || connectOrigin !== origin) return null;
  const walletName = wallet?.name ?? 'wallet';
  return (
    <p aria-live="polite" className={`text-xs leading-5 text-muted-foreground ${className}`}>
      No {walletName} window appeared? Open it from the browser toolbar, or open this page in Chrome or another
      browser where your wallet extension is installed.
    </p>
  );
}

/**
 * Shown when the wallet's own saved RPC for X Layer looks unreachable: its
 * health check failed (lib/wallet-health.ts) or a wallet request failed in
 * a way that points at it (lib/wallet-errors.ts). A wallet sends
 * transactions through the network it already has saved, which this site
 * can neither see nor change, so this only explains how to replace the RPC
 * by hand: in MetaMask's own menus when MetaMask is the wallet in use,
 * otherwise in general terms. Opens expanded by default, since until the
 * RPC is fixed nothing can be sent.
 */
export function ConnectionHelp({
  defaultOpen = true,
}: {
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const [primary, backup] = XLAYER_TESTNET_RPC_URLS;
  const { wallet } = useWeb3();
  const metaMask = wallet?.rdns === METAMASK_RDNS;
  const walletName = wallet?.name ?? 'your wallet';

  return (
    <div
      className="rounded-[2px] border border-warning/40 bg-warning/10 text-xs"
      role="alert"
    >
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
            You can replace the RPC yourself in {walletName}:
          </p>
          <ol className="list-decimal space-y-1 pl-4">
            {metaMask ? (
              <li>
                Open MetaMask, open the network menu, and find X Layer Testnet
                (chain ID 1952). Choose Edit.
              </li>
            ) : (
              <li>
                Open {walletName}&apos;s network settings and find X Layer
                Testnet (chain ID 1952).
              </li>
            )}
            <li>
              {metaMask
                ? 'Under Default RPC URL, choose Add RPC URL and paste:'
                : 'Replace its RPC URL with:'}
              <CopyableUrl label="primary" url={primary} />
              <span className="mt-1 block text-muted-foreground">
                If that one fails too, use the backup:
              </span>
              <CopyableUrl label="backup" url={backup} />
            </li>
            <li>
              {metaMask
                ? 'Select the new URL as the default and save.'
                : 'Save the network.'}
            </li>
            <li>Come back here and try again.</li>
          </ol>
        </div>
      )}
    </div>
  );
}
