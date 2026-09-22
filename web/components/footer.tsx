'use client';

import { explorerAddressUrl } from '@/lib/explorer';
import { useAddresses } from '@/lib/site-data';

const REPO_URL = 'https://github.com/Kemu-Ri-Kage/gridflex';

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Shared by both pages. `variant` controls container width (landing's
 * 1440px vs the terminal's wider 1920px) and whether hover links get the
 * landing page's 150-250ms micro-interaction transition - the terminal
 * gets none, per design-brief.md §13's "no decorative motion at all" rule,
 * which this one shared component would otherwise violate on /trade.
 */
export function Footer({ variant }: { variant: 'landing' | 'terminal' }) {
  const addresses = useAddresses();
  const maxWidth = variant === 'landing' ? 'max-w-[1440px]' : 'max-w-[1920px]';
  const linkClass =
    'text-muted-foreground hover:text-foreground' +
    (variant === 'landing' ? ' transition-colors duration-200' : '');

  const contracts: { label: string; address?: string }[] = [
    { label: 'GridOracle', address: addresses?.GridOracle },
    { label: 'MarketFactory', address: addresses?.MarketFactory },
    { label: 'MockUSDT', address: addresses?.MockUSDT },
  ];

  return (
    <footer className="border-t border-border">
      <div
        className={`mx-auto flex flex-col gap-2 ${maxWidth} px-4 py-6 font-mono text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8`}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {contracts.map((c) =>
            c.address ? (
              <a
                className={linkClass}
                href={explorerAddressUrl(c.address)}
                key={c.label}
                rel="noreferrer"
                target="_blank"
              >
                {c.label} {truncateAddress(c.address)}
              </a>
            ) : (
              <span className="text-muted-foreground/50" key={c.label}>
                {c.label} loading…
              </span>
            ),
          )}
        </div>
        <a className={linkClass} href={REPO_URL} rel="noreferrer" target="_blank">
          Source on GitHub
        </a>
      </div>
    </footer>
  );
}
