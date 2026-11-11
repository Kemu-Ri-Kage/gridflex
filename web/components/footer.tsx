'use client';

import Link from 'next/link';

import { explorerAddressUrl } from '@/lib/explorer';
import { useAddresses } from '@/lib/site-data';

const REPO_URL = 'https://github.com/Kemu-Ri-Kage/gridflex';
const GRIDSTATUS_URL = 'https://www.gridstatus.io';

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * The same quiet footer on every page: the pages, where the prices come from,
 * the contracts for anyone who wants to check them, and the one disclaimer.
 * `variant` is kept for the pages that still pass it.
 */
export function Footer(_props: { variant?: 'landing' | 'terminal' }) {
  const addresses = useAddresses();
  const contracts = [
    { label: 'Price oracle', address: addresses?.GridOracle },
    { label: 'Market factory', address: addresses?.MarketFactory },
    { label: 'Test dollars', address: addresses?.MockUSDT },
  ].filter((c): c is { label: string; address: string } => Boolean(c.address));

  return (
    <footer className="site-foot">
      <div className="wrap">
        <nav aria-label="Footer" className="fnav">
          <Link href="/futures" prefetch={false}>Futures</Link>
          <Link href="/options" prefetch={false}>Options</Link>
          <Link href="/hedge" prefetch={false}>Hedge</Link>
          <Link href="/trade" prefetch={false}>Yes / No</Link>
          <Link href="/proof" prefetch={false}>Proof</Link>
          <a href="/api/v1" rel="noreferrer" target="_blank">API for agents</a>
          <a href={REPO_URL} rel="noreferrer" target="_blank">Source</a>
        </nav>
        <p>
          Prices are ERCOT North Hub figures via{' '}
          <a href={GRIDSTATUS_URL} rel="noreferrer" target="_blank">GridStatus</a>. X Layer
          testnet, test money only.
          {contracts.length > 0 && (
            <>
              {' '}
              {contracts.map((c, i) => (
                <span key={c.label}>
                  {i > 0 && ' · '}
                  <a href={explorerAddressUrl(c.address)} rel="noreferrer" target="_blank">
                    {c.label} {short(c.address)}
                  </a>
                </span>
              ))}
            </>
          )}
        </p>
      </div>
    </footer>
  );
}
