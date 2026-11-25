'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { WalletButton } from '@/components/wallet-button';

/** Every page the header links to, in reading order. */
const PAGES = [
  { href: '/futures', label: 'Futures', note: 'Long or short' },
  { href: '/options', label: 'Options', note: 'Calls and puts' },
  { href: '/hedge', label: 'Hedge', note: 'Lock your price' },
  { href: '/trade', label: 'Yes / No', note: 'Questions by day' },
  { href: '/proof', label: 'Proof', note: 'Every price' },
] as const;

/**
 * One header for the whole site: the wordmark, the five pages, and the wallet
 * (or, on the home page, the way into the terminal). Fixed to the top; it
 * gains a hairline once the page scrolls under it. On a phone the pages move
 * into a full-screen menu.
 */
export function SiteHeader() {
  const path = usePathname() ?? '/';
  const home = path === '/';
  const [edge, setEdge] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      // on the home page the 3D story sits under the header, so the line
      // appears only once the story has scrolled past
      const story = home ? document.getElementById('story') : null;
      const limit = story ? story.offsetHeight - window.innerHeight : 4;
      setEdge(window.scrollY > limit);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [home]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const current = (href: string) =>
    path === href || path.startsWith(`${href}/`) ? 'page' : undefined;

  return (
    <header className={`top${edge ? ' edge' : ''}`} id="top">
      <div className="wrap">
        <Link aria-label="Gridflex home" className="mark" href="/" onClick={() => setOpen(false)}>
          GRIDFLEX
        </Link>
        <nav aria-label="Main" className="nav">
          {PAGES.map((p) => (
            <Link aria-current={current(p.href)} href={p.href} key={p.href} prefetch={false}>
              {p.label}
            </Link>
          ))}
        </nav>
        {home ? (
          <Link className="pill solid cta-top" href="/futures">
            Open terminal
          </Link>
        ) : (
          <div className="cta-top">
            <WalletButton />
          </div>
        )}
        <button
          aria-controls="sheet"
          aria-expanded={open}
          aria-label="Menu"
          className="menu-btn"
          onClick={() => setOpen((o) => !o)}
          type="button"
        >
          <span />
          <span />
        </button>
      </div>
      <nav aria-label="Main menu" className="sheet" hidden={!open} id="sheet">
        <Link aria-current={home ? 'page' : undefined} href="/" onClick={() => setOpen(false)}>
          Home
        </Link>
        {PAGES.map((p) => (
          <Link
            aria-current={current(p.href)}
            href={p.href}
            key={p.href}
            onClick={() => setOpen(false)}
            prefetch={false}
          >
            {p.label} <small>{p.note}</small>
          </Link>
        ))}
        {!home && (
          <div className="sheet-wallet">
            <WalletButton />
          </div>
        )}
      </nav>
    </header>
  );
}

/** Kept for the pages that still import the old names. */
export const LandingHeader = SiteHeader;
export type TerminalPage = 'trade' | 'futures' | 'options' | 'hedge';
export function TerminalHeader(_props: { current?: TerminalPage }) {
  return <SiteHeader />;
}
