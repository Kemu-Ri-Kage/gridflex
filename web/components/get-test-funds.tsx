'use client';

import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { faucetMessage, type FaucetResult, type FaucetStatus } from '@/lib/faucet';

const TURNSTILE_SCRIPT =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

type TurnstileApi = {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      theme?: 'auto' | 'light' | 'dark';
      size?: 'normal' | 'flexible' | 'compact';
    },
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileLoading: Promise<TurnstileApi> | null = null;

/** Cloudflare Turnstile's script, loaded once, only when the faucet asks for it. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  turnstileLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile'));
    script.onerror = () => {
      turnstileLoading = null;
      reject(new Error('turnstile'));
    };
    document.head.appendChild(script);
  });
  return turnstileLoading;
}

type State =
  | { kind: 'checking' }
  | { kind: 'off' }
  | { kind: 'ready' }
  | { kind: 'sending' }
  | { kind: 'done'; message: string }
  | { kind: 'failed'; error: string };

/**
 * One tap for a first-time trader's test funds: GRIDFLEX's faucet sends a
 * little test OKB for gas and mints 1,000 mUSDT to the connected wallet, so
 * nobody has to leave for a faucet site or pay gas to mint. While the faucet
 * is off (no key on the Worker), or after it fails, `fallback` is shown
 * instead: the manual route, the OKX faucet link and the mint button.
 */
export function GetTestFunds({
  account,
  buttonClassName,
  fallback,
  onFunded,
}: {
  account: string;
  buttonClassName: string;
  fallback: React.ReactNode;
  onFunded: () => void;
}) {
  const [state, setState] = React.useState<State>({ kind: 'checking' });
  const [siteKey, setSiteKey] = React.useState<string | null>(null);
  const [token, setToken] = React.useState<string | null>(null);
  const widgetBox = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    let live = true;
    fetch('/api/v1/faucet', { cache: 'no-store' })
      .then((response) => response.json() as Promise<FaucetStatus>)
      .then((status) => {
        if (!live) return;
        setSiteKey(status.turnstileSiteKey);
        setState(status.enabled ? { kind: 'ready' } : { kind: 'off' });
      })
      .catch(() => live && setState({ kind: 'off' }));
    return () => {
      live = false;
    };
  }, []);

  React.useEffect(() => {
    if (state.kind !== 'ready' || !siteKey || !widgetBox.current) return;
    let widgetId: string | undefined;
    let api: TurnstileApi | undefined;
    loadTurnstile()
      .then((turnstile) => {
        api = turnstile;
        if (!widgetBox.current) return;
        widgetId = turnstile.render(widgetBox.current, {
          sitekey: siteKey,
          callback: setToken,
          'expired-callback': () => setToken(null),
          theme: 'auto',
          size: 'flexible',
        });
      })
      .catch(() => setState({ kind: 'failed', error: 'The human check could not load.' }));
    return () => {
      if (api && widgetId) api.remove(widgetId);
    };
  }, [state.kind, siteKey]);

  const send = async () => {
    setState({ kind: 'sending' });
    try {
      const response = await fetch('/api/v1/faucet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: account, turnstileToken: token }),
      });
      const result = (await response.json()) as FaucetResult;
      if (result.ok) {
        setState({ kind: 'done', message: faucetMessage(result.sent) });
        onFunded();
      } else {
        setState({ kind: 'failed', error: result.error });
      }
    } catch {
      setState({ kind: 'failed', error: 'Could not reach the faucet. Try again.' });
    }
  };

  if (state.kind === 'checking') return null;
  if (state.kind === 'off') return <>{fallback}</>;

  return (
    <div className="space-y-2">
      {(state.kind === 'ready' || state.kind === 'sending') && (
        <>
          {siteKey && <div ref={widgetBox} />}
          <button
            className={buttonClassName}
            disabled={state.kind === 'sending' || (Boolean(siteKey) && !token)}
            onClick={() => void send()}
            type="button"
          >
            {state.kind === 'sending' ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" /> Sending test funds…
              </span>
            ) : (
              'Get free test funds'
            )}
          </button>
          <p className="text-xs leading-5 text-muted-foreground">
            1,000 test mUSDT plus a little test OKB for gas, sent to your
            wallet. No signature needed.
          </p>
        </>
      )}
      {state.kind === 'done' && (
        <p className="font-mono text-xs text-up">{state.message}</p>
      )}
      {state.kind === 'failed' && (
        <div className="space-y-2">
          <p className="font-mono text-xs text-down">{state.error}</p>
          {fallback}
        </div>
      )}
    </div>
  );
}
