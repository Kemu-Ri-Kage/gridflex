'use client';

import * as React from 'react';
import { createPublicClient, http, keccak256, toBytes, type Address } from 'viem';

import { addresses, gridOracleAbi, xLayerTestnet } from '@/lib/contracts';
import {
  applyCheckOutcome,
  initialVerificationState,
  verifyOnce,
  type ChainReading,
  type CommittedReading,
  type VerificationState,
} from '@/lib/feed-verification';

/** shared/feed-spec.md §9: one committed record per metric-day, as written by build_feed_data.py. */
export interface CommittedRecord {
  dayKey: number;
  marketDay: string;
  value: number;
  sourceHash: string;
  txHash: string | null;
}

export const ALL_FEED_METRICS = [
  'ERCOT_HBNORTH_DA_AVG',
  'ERCOT_WEST_NORTH_DA_BASIS',
  'ERCOT_LOAD_WEIGHTED_DA_INDEX',
  'ERCOT_HBWEST_NEG_INTERVALS',
] as const;

export type FeedMetricId = (typeof ALL_FEED_METRICS)[number];

/** shared/feed-spec.md §5: the two contract metrics get the charts; the hero is basis. */
export const HERO_METRIC: FeedMetricId = 'ERCOT_WEST_NORTH_DA_BASIS';
export const SECONDARY_METRIC: FeedMetricId = 'ERCOT_HBNORTH_DA_AVG';

export const METRIC_LABELS: Record<FeedMetricId, string> = {
  ERCOT_HBNORTH_DA_AVG: 'North Hub day-ahead',
  ERCOT_WEST_NORTH_DA_BASIS: 'West–North basis',
  ERCOT_LOAD_WEIGHTED_DA_INDEX: 'Load-weighted index',
  ERCOT_HBWEST_NEG_INTERVALS: 'West Hub negative intervals',
};

// A separate, wallet-free public client - deliberately not reusing
// web3-provider.tsx's internal one, since that file is integration-owned and out of
// scope for this page (see shared/feed-spec.md).
const publicClient = createPublicClient({ chain: xLayerTestnet, transport: http() });

async function fetchAggregate(metricId: FeedMetricId): Promise<CommittedRecord[]> {
  const response = await fetch(`/data/${metricId}.json`);
  if (!response.ok) return [];
  return (await response.json()) as CommittedRecord[];
}

function metricHashOf(metricId: string): `0x${string}` {
  return keccak256(toBytes(metricId));
}

/** Handles both shapes viem might decode a named-tuple struct into. */
function parseReadingResult(raw: unknown): { value: bigint; sourceHash: `0x${string}` } {
  if (Array.isArray(raw)) {
    return { value: raw[4] as bigint, sourceHash: raw[5] as `0x${string}` };
  }
  const obj = raw as { value: bigint; sourceHash: `0x${string}` };
  return { value: obj.value, sourceHash: obj.sourceHash };
}

async function fetchChainReading(metricId: string, dayKey: number): Promise<ChainReading> {
  if (!addresses.oracle) {
    throw new Error('Oracle address is not configured.');
  }
  const raw = await publicClient.readContract({
    address: addresses.oracle as Address,
    abi: gridOracleAbi,
    functionName: 'getReading',
    args: [metricHashOf(metricId), dayKey],
  });
  // A reading that was never submitted decodes with value=0/sourceHash=0x0..0
  // (getReading never reverts - oracle-interface.md) - that disagrees with any
  // real committed value/hash, so it resolves to MISMATCH through the normal
  // comparison below without any special-casing.
  return parseReadingResult(raw);
}

export interface VerifiedRow {
  metricId: FeedMetricId;
  metricLabel: string;
  record: CommittedRecord;
  verification: VerificationState;
}

export interface FeedData {
  loading: boolean;
  /** Every metric-day the aggregation step knows about, across all four in-scope metrics. */
  totalLocalCandidates: number;
  /** Metric-days the ledger says were actually submitted - the table's row count. */
  submittedCount: number;
  heroSeries: CommittedRecord[];
  secondarySeries: CommittedRecord[];
  rows: VerifiedRow[];
}

/**
 * shared/feed-spec.md §1-§4: fetches the committed aggregates (always
 * renders, no RPC dependency), then kicks off one live verify check per
 * submitted reading - each check runs independently and degrades per §6
 * without blocking or hiding the committed value it's checking.
 */
export function useFeedData(): FeedData {
  const [committed, setCommitted] = React.useState<Record<FeedMetricId, CommittedRecord[]> | null>(
    null,
  );
  const [verification, setVerification] = React.useState<Record<string, VerificationState>>({});

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        ALL_FEED_METRICS.map(async (metricId) => [metricId, await fetchAggregate(metricId)] as const),
      );
      if (cancelled) return;
      setCommitted(Object.fromEntries(entries) as Record<FeedMetricId, CommittedRecord[]>);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submittedRows = React.useMemo(() => {
    if (!committed) return [] as { metricId: FeedMetricId; record: CommittedRecord }[];
    const rows: { metricId: FeedMetricId; record: CommittedRecord }[] = [];
    for (const metricId of ALL_FEED_METRICS) {
      for (const record of committed[metricId] ?? []) {
        if (record.txHash) rows.push({ metricId, record });
      }
    }
    return rows;
  }, [committed]);

  React.useEffect(() => {
    if (submittedRows.length === 0) return;
    let cancelled = false;

    async function checkRow(metricId: FeedMetricId, record: CommittedRecord) {
      const key = `${metricId}:${record.dayKey}`;
      const committedReading: CommittedReading = { value: record.value, sourceHash: record.sourceHash };
      const outcome = await verifyOnce(committedReading, () => fetchChainReading(metricId, record.dayKey));
      if (cancelled) return;
      setVerification((previous) => ({
        ...previous,
        [key]: applyCheckOutcome(previous[key] ?? initialVerificationState, outcome),
      }));
    }

    for (const { metricId, record } of submittedRows) {
      void checkRow(metricId, record);
    }

    return () => {
      cancelled = true;
    };
  }, [submittedRows]);

  const totalLocalCandidates = React.useMemo(
    () => (committed ? ALL_FEED_METRICS.reduce((sum, id) => sum + (committed[id]?.length ?? 0), 0) : 0),
    [committed],
  );

  const rows: VerifiedRow[] = submittedRows.map(({ metricId, record }) => ({
    metricId,
    metricLabel: METRIC_LABELS[metricId],
    record,
    verification: verification[`${metricId}:${record.dayKey}`] ?? initialVerificationState,
  }));

  return {
    loading: committed === null,
    totalLocalCandidates,
    submittedCount: submittedRows.length,
    heroSeries: committed?.[HERO_METRIC] ?? [],
    secondarySeries: committed?.[SECONDARY_METRIC] ?? [],
    rows,
  };
}
