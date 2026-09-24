import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { WalletButton } from '@/components/wallet-button';

/**
 * Text-only wordmark, no icon (design-brief.md §2): GRID in the foreground
 * colour and bold, FLEX regular in the muted colour, one word read aloud.
 * FLEX brightens on hover - a colour change, the only kind the header's
 * links make.
 */
function Wordmark({ prefetch }: { prefetch?: boolean }) {
  return (
    <Link className="group font-mono text-[15px] tracking-[0.02em]" href="/" prefetch={prefetch}>
      <span className="font-bold text-foreground">GRID</span>
      <span className="text-muted-foreground transition-colors duration-200 group-hover:text-foreground">FLEX</span>
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
            href="#prices"
          >
            Prices
          </a>
          <a
            className="text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground"
            href="#how-we-verify"
          >
            How we verify
          </a>
          <a
            className="text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground"
            href="#proof"
          >
            Proof
          </a>
        </nav>
        <Link
          className="border border-foreground/40 px-4 py-2 font-mono text-xs uppercase tracking-[0.12em] text-foreground transition-[border-color,opacity] duration-200 hover:border-foreground active:opacity-70"
          href="/trade"
        >
          Open terminal
        </Link>
      </div>
    </header>
  );
}

/**
 * Links back to the landing page never prefetch it: a prefetch loads the
 * landing route's client code (GSAP, Lenis, the hero) into /trade, which
 * carries no motion libraries at all (design-brief.md §14).
 */
export function TerminalHeader() {
  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex h-14 max-w-[1920px] items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-8">
          <Wordmark prefetch={false} />
          <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
            <Link
              className="px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              href="/"
              prefetch={false}
            >
              Home
            </Link>
            <Link
              className="px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              href="/#proof"
              prefetch={false}
            >
              Proof
            </Link>
            <span className="px-3 py-2 text-sm text-foreground">Trade</span>
          </nav>
        </div>
        {/* The page's one disclaimer line (design-brief.md §5) wraps rather
            than shortens on narrow screens - both names must stay, and a
            nowrap badge beside the wallet button overflows at 390px. */}
        <div className="flex min-w-0 items-center gap-3">
          <Badge
            className="h-auto min-w-0 shrink rounded-[2px] whitespace-normal leading-tight sm:h-5 sm:whitespace-nowrap"
            variant="outline"
          >
            X Layer testnet · MockUSDT
          </Badge>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
