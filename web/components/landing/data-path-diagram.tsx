'use client';

import * as React from 'react';
import gsap from 'gsap';
import { ExternalLink } from 'lucide-react';

import { explorerAddressUrl, explorerTxUrl } from '@/lib/explorer';
import { useCommittedRecord, useAddresses, useEvidence } from '@/lib/site-data';
import { formatPrice } from '@/lib/format';

type StageId = 'source' | 'compute' | 'publish' | 'settle';

const STAGES: { id: StageId; label: string; dek: string }[] = [
  { id: 'source', label: 'Source', dek: 'ERCOT market data via GridStatus' },
  { id: 'compute', label: 'Compute', dek: 'Pipeline builds the metric, hashes the inputs' },
  { id: 'publish', label: 'Publish', dek: 'Reading written to GridOracle on X Layer' },
  { id: 'settle', label: 'Settle', dek: 'Contracts resolve against the finalized reading' },
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

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-foreground">{children}</span>;
}

function EvidencePanel({ stage }: { stage: StageId }) {
  const evidence = useEvidence();
  const addresses = useAddresses();
  const record = useCommittedRecord('ERCOT_HBNORTH_DA_AVG', 20260908);

  if (stage === 'source') {
    return (
      <div className="space-y-3">
        <p className="text-sm leading-6 text-muted-foreground">
          Day-ahead hourly settlement prices at ERCOT hub <Mono>HB_NORTH</Mono>, dataset{' '}
          <Mono>ercot_spp_day_ahead_hourly</Mono>, fetched from GridStatus.io — which
          redistributes public ERCOT data.
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
          <p className="text-xs text-muted-foreground">Loading real source files…</p>
        )}
        <p className="text-xs text-muted-foreground">
          {evidence?.sourceFiles.length ?? 4} monthly chunks feed the {evidence?.marketDay ?? '2026-09-08'}{' '}
          reading — cached raw, never re-fetched once present.
        </p>
      </div>
    );
  }

  if (stage === 'compute') {
    return (
      <div className="space-y-3">
        <p className="text-sm leading-6 text-muted-foreground">
          SHA-256 over the raw bytes of every source chunk above, concatenated in order — anyone
          can reproduce it from the same files.
        </p>
        <div className="border border-border bg-background/60 p-3">
          <div className="text-xs text-muted-foreground">sourceHash</div>
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
        <p className="text-sm leading-6 text-muted-foreground">
          The reading — value, sourceHash, and the market day — is written on-chain to{' '}
          <Mono>GridOracle</Mono> on X Layer testnet by the authorized reporter.
        </p>
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
            <div className="text-xs text-muted-foreground">ReadingSubmitted tx</div>
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
        Digital options and dated futures resolve strictly against the finalized reading — cash-settled
        on X Layer testnet, never against a live price feed a counterparty could dispute.
      </p>
      <div className="border border-border bg-background/60 p-4">
        <div className="text-xs text-muted-foreground">
          North Hub day-ahead average · {record?.marketDay ?? evidence?.marketDay ?? '2026-09-08'}
        </div>
        <div className="mt-1 font-mono text-xl font-semibold text-foreground">
          {record ? formatPrice(record.value, 'MWh') : 'loading…'}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          North Hub settled at {record ? formatPrice(record.value, 'MWh') : '…'}, above the $30
          strike used by the market listed on this day (dayKey {record?.dayKey ?? evidence?.dayKey}).
        </div>
      </div>
    </div>
  );
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
          {STAGES.map((stage, i) => (
            <button
              aria-selected={active === stage.id}
              className={
                'flex flex-col gap-2 bg-card px-4 py-5 text-left transition-[transform,background-color] duration-200 hover:-translate-y-0.5 focus:outline-none ' +
                (active === stage.id ? 'bg-accent' : 'hover:bg-accent/60')
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
              <span className="text-base font-semibold text-foreground">{stage.label}</span>
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
