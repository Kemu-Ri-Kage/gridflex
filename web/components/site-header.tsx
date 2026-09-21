import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { WalletButton } from '@/components/wallet-button';

/**
 * Text-only wordmark, no icon - the header previously carried a bolt-icon
 * badge; a text wordmark reads as more confident at hero scale and matches
 * shared/*.md's insistence on GRIDFLEX as a derivatives venue, not a brand
 * built around a logotype.
 */
function Wordmark() {
  return (
    <Link className="font-mono text-sm font-bold tracking-[-0.04em]" href="/">
      GRIDFLEX
    </Link>
  );
}

export function LandingHeader() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-4 sm:px-6 lg:px-8">
        <Wordmark />
        <nav aria-label="Primary" className="hidden items-center gap-6 md:flex">
          <a
            className="text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground"
            href="#problem"
          >
            Problem
          </a>
          <a
            className="text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground"
            href="#how-it-works"
          >
            How it works
          </a>
          <a
            className="text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground"
            href="#feed"
          >
            Feed
          </a>
        </nav>
        <Link
          className="border border-foreground px-4 py-2 font-mono text-xs uppercase tracking-[0.12em] text-foreground transition-colors duration-200 hover:bg-foreground hover:text-background"
          href="/trade"
        >
          Open terminal
        </Link>
      </div>
    </header>
  );
}

export function TerminalHeader() {
  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex h-14 max-w-[1920px] items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-8">
          <Wordmark />
          <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
            <Link
              className="px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              href="/"
            >
              Home
            </Link>
            <Link
              className="px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              href="/#feed"
            >
              Feed
            </Link>
            <span className="px-3 py-2 text-sm text-foreground">Trade</span>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <Badge className="hidden gap-1.5 sm:inline-flex" variant="outline">
            <span className="size-1.5 rounded-full bg-up" />
            X Layer testnet
          </Badge>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
