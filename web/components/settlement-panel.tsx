'use client';

import { ExternalLink } from 'lucide-react';

import { explorerTxUrl } from '@/lib/explorer';
import { formatPrice } from '@/lib/format';
import { FEATURED_MARKET } from '@/lib/market-copy';
import { useCommittedRecord, useEvidence } from '@/lib/site-data';

/**
 * Honest about what is and isn't deployed: shows the real oracle reading
 * directly, never as a market outcome. No BinaryMarket exists for this
 * dayKey yet (shared/addresses.json), so there is no "SETTLED · YES" to
 * report - only the published reading, which is real regardless.
 */
export function SettlementPanel() {
  const evidence = useEvidence();
  const record = useCommittedRecord(FEATURED_MARKET.metricId, FEATURED_MARKET.dayKey);
  const above = evidence ? evidence.value > FEATURED_MARKET.strikeDollars * 100 : null;

  return (
    <div className="grid gap-4 p-4 sm:grid-cols-[1fr_1fr] sm:p-6">
      <div>
        <div className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
          Oracle reading
        </div>
        {evidence ? (
          <>
            <p className="mt-2 text-sm leading-6 text-foreground">
              North Hub settled at {formatPrice(evidence.value, 'MWh')} on {FEATURED_MARKET.marketDayLabel},{' '}
              {above ? 'above' : 'at or below'} the ${FEATURED_MARKET.strikeDollars} strike used by this
              market design.
            </p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              This is the oracle&rsquo;s published reading (dayKey {evidence.dayKey}), read directly —
              not a market outcome. No <span className="font-mono">BinaryMarket</span> is deployed
              for this day yet, so there is nothing on chain to resolve as YES or NO.
            </p>
          </>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
        )}
      </div>
      <div>
        <div className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
          Verification
        </div>
        <dl className="mt-2 space-y-2 text-xs">
          <div>
            <dt className="text-muted-foreground">sourceHash</dt>
            <dd className="break-all font-mono text-foreground">
              {evidence?.sourceHash ?? '…'}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">ReadingSubmitted tx</dt>
            <dd>
              {record?.txHash ? (
                <a
                  className="flex items-center gap-1 break-all font-mono text-chart-1 hover:underline"
                  href={explorerTxUrl(record.txHash)}
                  rel="noreferrer"
                  target="_blank"
                >
                  {record.txHash}
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              ) : (
                <span className="text-muted-foreground">…</span>
              )}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
