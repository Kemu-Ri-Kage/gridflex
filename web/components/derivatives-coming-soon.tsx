'use client';

import { LivePriceChip } from '@/components/live-price';
import { Stat } from '@/components/terminal-ui';

/**
 * What the futures and options screens show until their contracts are
 * deployed on X Layer testnet: what the market is and how it works, beside
 * the live Texas price.
 */
export function DerivativesComingSoon({
  code,
  name,
  lines,
  facts,
}: {
  code: string;
  name: string;
  lines: readonly string[];
  facts: readonly { label: string; value: string }[];
}) {
  return (
    <section className="mx-auto w-full max-w-[1100px] px-4 py-10 sm:px-6 lg:py-16">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        <span>{code}</span>
        <span className="rounded-[2px] border border-warning/40 px-1.5 py-[3px] leading-none text-warning">
          Opening on testnet
        </span>
        <LivePriceChip className="flex" />
      </div>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
        {name}
      </h1>
      <ul className="mt-6 max-w-2xl space-y-3 text-sm leading-6 text-muted-foreground">
        {lines.map((line) => (
          <li className="flex gap-3" key={line}>
            <span
              aria-hidden
              className="mt-2.5 size-1 shrink-0 rounded-full bg-muted-foreground"
            />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      <div className="mt-10 grid grid-cols-2 gap-x-6 gap-y-6 border-t border-border pt-6 sm:grid-cols-4">
        {facts.map((fact) => (
          <Stat key={fact.label} label={fact.label}>
            <span className="text-base">{fact.value}</span>
          </Stat>
        ))}
      </div>
      <p className="mt-10 text-xs leading-5 text-muted-foreground">
        The contracts are built and tested and are being reviewed before they go
        on X Layer testnet. Test money only (MockUSDT); nothing here is a
        real-money product.
      </p>
    </section>
  );
}
