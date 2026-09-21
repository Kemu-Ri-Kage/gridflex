import Link from 'next/link';

export function Hero() {
  return (
    <section className="border-b border-border py-20 sm:py-28 lg:py-36">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <p className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
          X Layer testnet · OKX Dev Day 2026
        </p>
        <h1 className="mt-6 max-w-4xl text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl">
          Power derivatives, settled against data you can verify yourself.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
          GRIDFLEX publishes verified ERCOT power-market data onchain, with a hash of the source
          attached to every reading, then lists cash-settled contracts that resolve against it —
          on X Layer testnet, settled in MockUSDT. Nothing here is redeemable for electricity —
          this is a derivatives venue.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link
            className="border border-foreground bg-foreground px-6 py-3 font-mono text-xs uppercase tracking-[0.12em] text-background hover:bg-transparent hover:text-foreground"
            href="/trade"
          >
            Open terminal
          </Link>
          <a
            className="px-6 py-3 font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground"
            href="#how-it-works"
          >
            See the data path ↓
          </a>
        </div>
      </div>
    </section>
  );
}
