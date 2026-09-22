'use client';

import * as React from 'react';
import gsap from 'gsap';
import { ExternalLink } from 'lucide-react';

import { explorerAddressUrl, explorerTxUrl } from '@/lib/explorer';
import { useCommittedRecord, useAddresses, useEvidence } from '@/lib/site-data';
import { formatPrice } from '@/lib/format';
import { dayLabel, strikeLabel, useMarkets, type Market } from '@/lib/markets';

type StageId = 'source' | 'compute' | 'publish' | 'settle';

const STAGES: { id: StageId; label: string; dek: string }[] = [
  { id: 'source', label: 'Source', dek: "ERCOT, Texas's official grid price, via GridStatus" },
  { id: 'compute', label: 'Compute', dek: 'Average of 24 hourly prices, hashed with its inputs' },
  { id: 'publish', label: 'Publish', dek: 'Price written to the oracle on X Layer' },
  { id: 'settle', label: 'Settle', dek: 'YES/NO questions settle against the published price' },
];

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Crossfades evidence content on stage change (transform + opacity only,
 * per design-brief.md §13/checklist #25) so the diagram visibly changes
 * state rather than just swapping text. Instant under
 * prefers-reduced-motion.
 */
function AnimatedEvidence({ stageKey, children }: { stageKey: StageId; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    gsap.fromTo(el, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.35, ease: 'power2.out' });
  }, [stageKey]);

  return (
    <div key={stageKey} ref={ref}>
      {children}
    </div>
  );
}

function EvidencePanel({ stage }: { stage: StageId }) {
  const evidence = useEvidence();
  const addresses = useAddresses();
  const record = useCommittedRecord('ERCOT_HBNORTH_DA_AVG', 20260908);

  if (stage === 'source') {
    return (
      <div className="space-y-3">
        {/* The file names are the hash inputs, shown verbatim so the hash
            can be reproduced - data, like an address (design-brief.md §5). */}
        <p className="text-sm leading-6 text-muted-foreground">
          Hourly day-ahead prices from ERCOT, Texas&apos;s official grid price, via GridStatus.io
        </p>
        {evidence ? (
          <div className="border border-border bg-background/60 p-3 font-mono text-xs leading-5 text-muted-foreground">
            {evidence.sourceFiles.map((file) => (
              <div className="truncate" key={file}>
                {file}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
        {evidence && (
          <p className="font-mono text-xs text-muted-foreground">
            {evidence.sourceFiles.length} source files · {dayLabel(evidence.dayKey, true)} reading
          </p>
        )}
      </div>
    );
  }

  if (stage === 'compute') {
    return (
      <div className="space-y-3">
        <p className="text-sm leading-6 text-muted-foreground">
          SHA-256 of the files above, in order.
        </p>
        <div className="border border-border bg-background/60 p-3">
          <div className="text-xs text-muted-foreground">SHA-256</div>
          <div className="mt-1 break-all font-mono text-sm text-foreground">
            {evidence?.sourceHash ?? 'loading…'}
          </div>
        </div>
        <p className="font-mono text-xs leading-5 text-muted-foreground">
          $ cat {evidence?.sourceFiles[0] ?? '…'} … | shasum -a 256
        </p>
      </div>
    );
  }

  if (stage === 'publish') {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="border border-border bg-background/60 p-3">
            <div className="text-xs text-muted-foreground">GridOracle</div>
            <a
              className="mt-1 flex items-center gap-1 truncate font-mono text-sm text-chart-1 transition-colors duration-200 hover:text-foreground hover:underline"
              href={addresses ? explorerAddressUrl(addresses.GridOracle) : undefined}
              rel="noreferrer"
              target="_blank"
            >
              {addresses?.GridOracle ?? 'loading…'}
              <ExternalLink className="size-3 shrink-0" />
            </a>
          </div>
          <div className="border border-border bg-background/60 p-3">
            <div className="text-xs text-muted-foreground">Oracle tx</div>
            <a
              className="mt-1 flex items-center gap-1 truncate font-mono text-sm text-chart-1 transition-colors duration-200 hover:text-foreground hover:underline"
              href={record?.txHash ? explorerTxUrl(record.txHash) : undefined}
              rel="noreferrer"
              target="_blank"
            >
              {record?.txHash ? `${record.txHash.slice(0, 14)}…` : 'loading…'}
              <ExternalLink className="size-3 shrink-0" />
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm leading-6 text-muted-foreground">
        YES/NO questions settle against this price.
      </p>
      <div className="border border-border bg-background/60 p-4">
        <div className="text-xs text-muted-foreground">
          Texas power price ·{' '}
          {record ? dayLabel(record.dayKey, true) : evidence ? dayLabel(evidence.dayKey, true) : '…'}
        </div>
        <div className="mt-1 font-mono text-xl font-semibold text-foreground">
          {record ? formatPrice(record.value, 'MWh') : 'loading…'}
        </div>
        {record && (
          <div className="mt-1 text-xs text-muted-foreground">
            <SettleStatus dayKey={record.dayKey} value={record.value} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * design-brief.md §6, driven by chain state: with no BinaryMarket for the
 * day, only the reading is stated; with one, its strike and status come
 * from the contract.
 */
function SettleStatus({ dayKey, value }: { dayKey: number; value: number }) {
  const { markets, now } = useMarkets();
  if (!markets) return <>…</>;

  const reading = `Texas power price settled at ${formatPrice(value, 'MWh')}`;
  const market = markets.find((m) => m.metricId === 'ERCOT_HBNORTH_DA_AVG' && m.dayKey === dayKey);
  if (!market) return <>{reading}.</>;

  const side = value > market.threshold ? 'above' : 'at or below';
  return (
    <>
      {reading}, {side} the {strikeLabel(market)} strike. {marketSentence(market, now)}
    </>
  );
}

function marketSentence(market: Market, now: number): string {
  if (!market.live) return '';
  if (market.live.resolved) return `Market resolved ${market.live.yesWon ? 'YES' : 'NO'}.`;
  if (market.live.cancelled) return 'Market cancelled.';
  return now < market.resolveAfter * 1000 ? 'Market trading.' : 'Market awaiting resolution.';
}

export function DataPathDiagram() {
  const [pinned, setPinned] = React.useState<StageId | null>(null);
  const [hovered, setHovered] = React.useState<StageId | null>(null);
  const active = pinned ?? hovered ?? 'source';
  const activeIndex = STAGES.findIndex((s) => s.id === active);
  const indicatorRef = React.useRef<HTMLDivElement | null>(null);

  React.useLayoutEffect(() => {
    const el = indicatorRef.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      gsap.set(el, { xPercent: activeIndex * 100 });
      return;
    }
    gsap.to(el, { xPercent: activeIndex * 100, duration: 0.5, ease: 'power2.out' });
  }, [activeIndex]);

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[1fr_1fr]">
      <div className="min-w-0">
        {/* Flow indicator — teaches that data moves Source -> Settle. Only
            `transform` (xPercent) is animated, matching stage-column width
            exactly so it tracks the active tile precisely at any viewport
            width. Hidden below sm, where stages stack 2x2 and a single
            left-to-right flow reads wrong. */}
        <div className="relative hidden h-0.5 bg-border sm:block">
          <div className="absolute inset-y-0 left-0 w-1/4 bg-foreground" ref={indicatorRef} />
        </div>
        <div
          className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4"
          role="tablist"
        >
          {/* The active stage is marked by a foreground bottom border and
              brighter text, never a background change; hover lifts it
              (the translate property) and moves only text/border colour (§13). The lift
              is motion-safe only - under prefers-reduced-motion the tile
              stays put. Keyboard focus draws an inset outline, since the
              grid's 1px gaps would clip an outer one. */}
          {STAGES.map((stage, i) => (
            <button
              aria-selected={active === stage.id}
              className={
                'group flex flex-col gap-2 border-b-2 bg-card px-4 py-5 text-left transition-[translate,color,border-color] duration-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground motion-safe:hover:-translate-y-0.5 ' +
                (active === stage.id ? 'border-foreground' : 'border-transparent')
              }
              key={stage.id}
              onClick={() => setPinned(stage.id === pinned ? null : stage.id)}
              onMouseEnter={() => setHovered(stage.id)}
              onMouseLeave={() => setHovered(null)}
              role="tab"
              type="button"
            >
              <span className="font-mono text-xs text-muted-foreground">
                0{i + 1}
              </span>
              <span
                className={
                  'text-base font-semibold transition-colors duration-200 group-hover:text-foreground ' +
                  (active === stage.id ? 'text-foreground' : 'text-muted-foreground')
                }
              >
                {stage.label}
              </span>
              <span className="text-xs leading-5 text-muted-foreground">{stage.dek}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-w-0 border border-border bg-card p-5">
        <div className="mb-3 font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
          Evidence — {STAGES.find((s) => s.id === active)?.label}
        </div>
        <AnimatedEvidence stageKey={active}>
          <EvidencePanel stage={active} />
        </AnimatedEvidence>
      </div>
    </div>
  );
}
