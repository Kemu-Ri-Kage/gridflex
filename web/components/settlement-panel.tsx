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

function cents(priceE18: bigint, side: 'YES' | 'NO'): string {
  const yes = Number(priceE18) / 1e16;
  return `${(side === 'YES' ? yes : 100 - yes).toFixed(1)}¢`;
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  );
}

/**
 * Right-column summary: only what the instrument bar above doesn't already
 * say, as labels and numbers. Everything is read from the selected
 * market's contract (lib/markets.tsx).
 */
export function SettlementSummary() {
  const { selected, now } = useMarkets();
  const reading = useOracleReading(selected?.metricIdBytes, selected?.dayKey);
  const status = selected ? marketStatus(selected, now) : undefined;
  const live = selected?.live;

  return (
    <div className="border border-border bg-card p-3">
      <div className="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground">
        Settlement
      </div>
      {!selected || !live || !status ? (
        <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
      ) : (
        <dl className="mt-2 divide-y divide-border text-xs">
          {status === 'trading' && (
            <>
              <Row
                label="Trading closes"
                value={formatUtc(selected.resolveAfter)}
              />
              <Row label="YES" value={cents(live.priceE18, 'YES')} />
              <Row label="NO" value={cents(live.priceE18, 'NO')} />
            </>
          )}
          {status === 'awaiting' && (
            <>
              <Row
                label="Trading closed"
                value={formatUtc(selected.resolveAfter)}
              />
              <Row label="Last YES" value={cents(live.priceE18, 'YES')} />
              <Row label="Last NO" value={cents(live.priceE18, 'NO')} />
              <Row
                label="Reading"
                value={
                  reading
                    ? reading.finalized
                      ? 'Final'
                      : 'Not final'
                    : 'Not published'
                }
              />
            </>
          )}
          {status === 'resolved' && (
            <>
              <Row label="Outcome" value={live.yesWon ? 'YES' : 'NO'} />
              <Row
                label="Payout"
                value={`1 mUSDT per ${live.yesWon ? 'YES' : 'NO'}`}
              />
            </>
          )}
          {status === 'cancelled' && (
            <Row label="Payout" value="0.5 mUSDT per YES or NO" />
          )}
        </dl>
      )}
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
        <dt className="text-muted-foreground">BinaryMarket</dt>
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
            <dt className="text-muted-foreground">sourceHash</dt>
            <dd className="break-all font-mono text-foreground">
              {reading?.sourceHash ?? '…'}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">ReadingSubmitted tx</dt>
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
          <div>
            <dt className="text-muted-foreground">Finalized</dt>
            <dd className="font-mono text-foreground">
              {reading ? (reading.finalized ? 'Yes' : 'No') : '…'}
            </dd>
          </div>
        </>
      )}
    </dl>
  );
}
