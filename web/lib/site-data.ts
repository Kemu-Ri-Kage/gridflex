'use client';

import * as React from 'react';

import type { CommittedRecord, FeedMetricId } from '@/lib/feed-data';

/**
 * Generic per-metric committed-record fetch, shared by the landing page's
 * diagram and the trade page's instrument/settlement panels. Same source
 * (`/data/<metricId>.json`, written by build_feed_data.py) and shape
 * feed-data.ts already uses for the feed page - kept separate from that
 * file because those two pages have no other reason to share state.
 */
export function useCommittedRecords(metricId: FeedMetricId): CommittedRecord[] | null {
  const [records, setRecords] = React.useState<CommittedRecord[] | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void fetch(`/data/${metricId}.json`)
      .then((response) => (response.ok ? (response.json() as Promise<CommittedRecord[]>) : []))
      .then((data) => {
        if (!cancelled) setRecords(data);
      })
      .catch(() => {
        if (!cancelled) setRecords([]);
      });
    return () => {
      cancelled = true;
    };
  }, [metricId]);

  return records;
}

export function useCommittedRecord(
  metricId: FeedMetricId,
  dayKey: number,
): CommittedRecord | null {
  const records = useCommittedRecords(metricId);
  return React.useMemo(
    () => records?.find((record) => record.dayKey === dayKey) ?? null,
    [records, dayKey],
  );
}

/** shared/addresses.json's public subset, published by build_feed_data.py - see write_addresses(). */
export interface PublicAddresses {
  chainId: number;
  GridOracle: string;
  MarketFactory: string;
  MockUSDT: string;
  GridOracleDeployTx: string;
  /** Listed BinaryMarkets; everything else about them is read from chain (lib/markets.tsx). */
  markets?: { market: string; createTxHash: string }[];
}

/** shared/metrics.md-shaped evidence for one real, already-settled day, published by write_evidence(). */
export interface DemoDayEvidence {
  metricId: string;
  dayKey: number;
  marketDay: string;
  marketDayStartUtc: number;
  marketDayEndUtc: number;
  value: number;
  sourceHash: string;
  sourceFiles: string[];
  hashAlgorithm: string;
}

export function useEvidence(): DemoDayEvidence | null {
  const [evidence, setEvidence] = React.useState<DemoDayEvidence | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void fetch('/data/evidence-demo-day.json')
      .then((response) => (response.ok ? (response.json() as Promise<DemoDayEvidence>) : null))
      .then((data) => {
        if (!cancelled) setEvidence(data);
      })
      .catch(() => {
        if (!cancelled) setEvidence(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return evidence;
}

export function useAddresses(): PublicAddresses | null {
  const [addresses, setAddresses] = React.useState<PublicAddresses | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void fetch('/data/addresses.json')
      .then((response) => (response.ok ? (response.json() as Promise<PublicAddresses>) : null))
      .then((data) => {
        if (!cancelled) setAddresses(data);
      })
      .catch(() => {
        if (!cancelled) setAddresses(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return addresses;
}
