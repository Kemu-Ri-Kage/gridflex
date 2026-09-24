'use client';

import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';

import { explorerAddressUrl, explorerTxUrl } from '@/lib/explorer';
import {
  formatUtc,
  marketStatus,
  useMarkets,
  useOracleReading,
} from '@/lib/markets';
import { useCommittedRecord } from '@/lib/site-data';

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono text-[13px] tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  );
}

/**
 * Right-column summary: only what the instrument bar above doesn't already
 * say, as labels and numbers. While the market trades that is nothing -
 * the bar carries the quote and the time left - so it shows once trading
 * has closed (design-brief.md §8). Everything is read from the selected
 * market's contract (lib/markets.tsx).
 */
export function SettlementSummary() {
  const { selected, now } = useMarkets();
  const reading = useOracleReading(selected?.metricIdBytes, selected?.dayKey);
  const status = selected ? marketStatus(selected, now) : undefined;
  const live = selected?.live;

  // Nothing until the state is known either: the market selected first is
  // one that trades, so a placeholder here would only vanish again and
  // move the ticket up.
  if (!selected || !live || !status || status === 'trading') return null;

  const winner = live.yesWon ? 'YES' : 'NO';

  return (
    <div className="rounded-[2px] border border-border bg-card">
      <div className="border-b border-border px-3 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        Settlement
      </div>
      <dl className="divide-y divide-border px-3 text-xs">
        {status === 'awaiting' && (
          <>
            <Row
              label="Trading closed"
              value={formatUtc(selected.resolveAfter)}
            />
            {/* A published reading is already in the instrument bar;
                only its absence needs saying here. */}
            {reading === null && (
              <Row label="Oracle reading" value="Not published" />
            )}
          </>
        )}
        {status === 'resolved' && (
          <>
            {/* The outcome itself is the instrument bar's headline. */}
            <Row label="Payout" value={`1 mUSDT per ${winner}`} />
          </>
        )}
        {status === 'cancelled' && (
          <Row label="Payout" value="0.5 mUSDT per YES or NO" />
        )}
      </dl>
    </div>
  );
}

function ExternalAnchor({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      className="inline-flex items-center gap-1 break-all font-mono text-chart-1 hover:underline"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
      <ExternalLink className="size-3 shrink-0" />
    </a>
  );
}

/** Settlement tab: the full on-chain evidence behind the summary. */
export function SettlementEvidence() {
  const { selected } = useMarkets();
  const reading = useOracleReading(selected?.metricIdBytes, selected?.dayKey);
  const record = useCommittedRecord(
    selected?.metricId ?? 'ERCOT_HBNORTH_DA_AVG',
    selected?.dayKey ?? 0,
  );

  if (!selected) {
    return <p className="p-4 text-xs text-muted-foreground sm:p-6">Loading…</p>;
  }

  return (
    <dl className="grid gap-x-8 gap-y-3 p-4 text-xs sm:grid-cols-2 sm:p-6">
      <div>
        <dt className="text-muted-foreground">Contract</dt>
        <dd>
          <ExternalAnchor href={explorerAddressUrl(selected.address)}>
            {selected.address}
          </ExternalAnchor>
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Created tx</dt>
        <dd>
          <ExternalAnchor href={explorerTxUrl(selected.createTxHash)}>
            {selected.createTxHash}
          </ExternalAnchor>
        </dd>
      </div>
      {reading === null ? (
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">Oracle reading</dt>
          <dd className="text-foreground">No reading published yet.</dd>
        </div>
      ) : (
        <>
          <div>
            <dt className="text-muted-foreground">Verified</dt>
            <dd className="break-all font-mono text-foreground">
              {reading?.sourceHash ?? '…'}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Oracle tx</dt>
            <dd>
              {record?.txHash ? (
                <ExternalAnchor href={explorerTxUrl(record.txHash)}>
                  {record.txHash}
                </ExternalAnchor>
              ) : (
                <span className="text-muted-foreground">…</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Published</dt>
            <dd className="font-mono tabular-nums text-foreground">
              {reading ? formatUtc(reading.publishedAt) : '…'}
            </dd>
          </div>
        </>
      )}
    </dl>
  );
}
