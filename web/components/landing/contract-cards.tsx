'use client';

import * as React from 'react';
import Link from 'next/link';

import { closesIn } from '@/lib/closes-in';
import { byTerm, TERM_LABELS, termOf, type Term } from '@/lib/market-term';
import { formatCentsE18 } from '@/lib/format';
import { dayLabel, marketName, marketStatus, statusLabel, strikeLabel, type Market } from '@/lib/markets';

const ONE_E18 = 10n ** 18n;
/** How far a card leans toward the pointer, degrees. */
const TILT = 5;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * One listed question as a card you can hold: its status and time left to
 * trade, the question, what it settles on, and YES and NO in cents from the
 * contract. It leans toward the pointer (transform only, design-brief.md
 * §13) and opens the terminal on that market.
 */
function ContractCard({ market, now, term }: { market: Market; now: number; term: Term }) {
  const ref = React.useRef<HTMLAnchorElement | null>(null);
  const status = marketStatus(market, now);
  const left = status === 'trading' ? closesIn(market.resolveAfter, now) : null;
  // Trading: the pool's price. Settled: what each side pays out per token,
  // since the pool's last price no longer means anything.
  const price =
    status === 'resolved'
      ? market.live?.yesWon
        ? ONE_E18
        : 0n
      : status === 'cancelled'
        ? ONE_E18 / 2n
        : market.live?.priceE18;
  const settled = status === 'resolved' || status === 'cancelled';

  const lean = (event: React.PointerEvent<HTMLAnchorElement>) => {
    const el = ref.current;
    if (!el || event.pointerType !== 'mouse' || prefersReducedMotion()) return;
    const rect = el.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    el.style.transform = `rotateX(${(-y * TILT).toFixed(2)}deg) rotateY(${(x * TILT).toFixed(2)}deg) translateZ(0)`;
  };
  const settle = () => {
    if (ref.current) ref.current.style.transform = '';
  };

  return (
    <Link
      className="group flex flex-col justify-between gap-8 border border-border bg-background p-6 transition-[transform,color] duration-300 ease-out will-change-transform hover:border-foreground/40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-foreground"
      href={`/trade?market=${market.address}`}
      onPointerLeave={settle}
      onPointerMove={lean}
      ref={ref}
    >
      <div>
        <div className="flex items-center justify-between gap-3 font-mono text-[11px] uppercase tracking-[0.14em]">
          <span className={status === 'trading' ? 'text-up' : 'text-muted-foreground'}>
            {statusLabel(market, now) ?? '…'}
            {status === 'trading' && <span className="text-muted-foreground"> · {TERM_LABELS[term]}</span>}
          </span>
          {left && <span className="tabular-nums text-muted-foreground">Closes in {left}</span>}
        </div>
        <p className="mt-5 text-xl font-semibold leading-snug tracking-tight text-foreground">{marketName(market)}</p>
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          Strike {strikeLabel(market)} · settles on {dayLabel(market.dayKey, true)}
        </p>
      </div>
      <div className="flex items-end justify-between gap-4">
        <div className="flex gap-6 font-mono tabular-nums">
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              {settled ? 'YES paid' : 'YES'}
            </div>
            <div className="mt-1 text-2xl text-up">{price === undefined ? '—' : formatCentsE18(price)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              {settled ? 'NO paid' : 'NO'}
            </div>
            <div className="mt-1 text-2xl text-down">{price === undefined ? '—' : formatCentsE18(ONE_E18 - price)}</div>
          </div>
        </div>
        <span className="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground transition-colors duration-200 group-hover:text-foreground">
          {status === 'trading' ? 'Trade →' : 'View →'}
        </span>
      </div>
    </Link>
  );
}

/** Trading cards shown before the link to the rest; one settled card follows them. */
const TRADING_CARDS = 5;

/**
 * The questions that settle soonest, by maturity (lib/market-term.ts), and
 * the latest settled one to show what settling looks like, as cards on a
 * hairline grid; the full ladder is one link away in the terminal.
 */
export function ContractCards({ markets, now }: { markets: Market[]; now: number }) {
  const { shown, rest } = React.useMemo(() => {
    const ordered = byTerm(
      markets.map((market) => ({
        market,
        term: termOf(marketStatus(market, now), market.resolveAfter, now),
        resolveAfter: market.resolveAfter,
        dayKey: market.dayKey,
        threshold: market.threshold,
      })),
    );
    const open = ordered.filter((entry) => entry.term !== 'settled').slice(0, TRADING_CARDS);
    const settled = ordered.filter((entry) => entry.term === 'settled').slice(0, 1);
    const picked = [...open, ...settled];
    return { shown: picked, rest: markets.length - picked.length };
  }, [markets, now]);

  return (
    <div>
      <div className="grid gap-px border border-border bg-border [perspective:1200px] sm:grid-cols-2 xl:grid-cols-3">
        {shown.map(({ market, term }) => (
          <ContractCard key={market.address} market={market} now={now} term={term} />
        ))}
      </div>
      {rest > 0 && (
        <Link
          className="mt-4 inline-block font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground transition-colors duration-200 hover:text-foreground"
          href="/trade"
        >
          {rest} more {rest === 1 ? 'market' : 'markets'}, every day to {lastDay(markets)}, in the terminal →
        </Link>
      )}
    </div>
  );
}

/** The furthest market day listed, e.g. "2 Oct". */
function lastDay(markets: Market[]): string {
  return dayLabel(Math.max(...markets.map((market) => market.dayKey)));
}
