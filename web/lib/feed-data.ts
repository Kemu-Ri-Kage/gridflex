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

/**
 * The one metric the public site shows - the Texas power price
 * (design-brief.md §5). The other feed files are still published under
 * /data/, just not rendered on a public page.
 */
export const PUBLIC_FEED_METRIC: FeedMetricId = 'ERCOT_HBNORTH_DA_AVG';

// A separate, wallet-free public client - deliberately not reusing
// web3-provider.tsx's internal one, since that file is integration-owned and out of
// scope for this page (see shared/feed-spec.md).
const publicClient = createPublicClient({ chain: xLayerTestnet, transport: http() });

/** build_feed_data.py's feed-meta.json: when the price data was last refreshed. */
async function fetchUpdatedAt(): Promise<string | null> {
  const response = await fetch('/data/feed-meta.json');
  if (!response.ok) return null;
  const meta = (await response.json()) as { updatedAt?: string | null };
  return meta.updatedAt ?? null;
}

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
  record: CommittedRecord;
  verification: VerificationState;
}

export interface FeedData {
  loading: boolean;
  /** Every day of the public metric the aggregation step knows about. */
  totalLocalCandidates: number;
  /** Days the ledger says were actually submitted - the table's row count. */
  submittedCount: number;
  /** ISO time the price data was last refreshed, or null if unknown. */
  updatedAt: string | null;
  rows: VerifiedRow[];
}

/**
 * shared/feed-spec.md §1-§4: fetches the committed aggregates (always
 * renders, no RPC dependency), then kicks off one live verify check per
 * submitted reading - each check runs independently and degrades per §6
 * without blocking or hiding the committed value it's checking.
 */
export function useFeedData(): FeedData {
  const [committed, setCommitted] = React.useState<CommittedRecord[] | null>(null);
  const [verification, setVerification] = React.useState<Record<number, VerificationState>>({});
  const [updatedAt, setUpdatedAt] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void fetchAggregate(PUBLIC_FEED_METRIC).then((records) => {
      if (!cancelled) setCommitted(records);
    });
    // Separate from the aggregate: a missing meta file only hides the
    // "Updated" line, never the committed prices.
    void fetchUpdatedAt()
      .catch(() => null)
      .then((stamp) => {
        if (!cancelled) setUpdatedAt(stamp);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submitted = React.useMemo(
    () => (committed ?? []).filter((record) => record.txHash),
    [committed],
  );

  React.useEffect(() => {
    if (submitted.length === 0) return;
    let cancelled = false;

    async function checkRow(record: CommittedRecord) {
      const committedReading: CommittedReading = { value: record.value, sourceHash: record.sourceHash };
      const outcome = await verifyOnce(committedReading, () =>
        fetchChainReading(PUBLIC_FEED_METRIC, record.dayKey),
      );
      if (cancelled) return;
      setVerification((previous) => ({
        ...previous,
        [record.dayKey]: applyCheckOutcome(previous[record.dayKey] ?? initialVerificationState, outcome),
      }));
    }

    for (const record of submitted) {
      void checkRow(record);
    }

    return () => {
      cancelled = true;
    };
  }, [submitted]);

  const rows: VerifiedRow[] = submitted.map((record) => ({
    record,
    verification: verification[record.dayKey] ?? initialVerificationState,
  }));

  return {
    loading: committed === null,
    totalLocalCandidates: committed?.length ?? 0,
    submittedCount: submitted.length,
    updatedAt,
    rows,
  };
}
