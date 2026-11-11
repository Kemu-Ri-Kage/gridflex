'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPublicClient, keccak256, toBytes, type Address } from 'viem';

import { gridOracleAbi, xLayerTestnet, xLayerTransport } from '@/lib/contracts';
import { explorerAddressUrl, explorerTxUrl } from '@/lib/explorer';
import { useFeedData, type VerifiedRow } from '@/lib/feed-data';
import { useMarkets } from '@/lib/markets';
import { useAddresses, useCommittedRecords } from '@/lib/site-data';

const usd = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const METRIC = 'ERCOT_HBNORTH_DA_AVG';

function dayLong(dayKey: number): string {
  const d = new Date(Date.UTC(Math.floor(dayKey / 10_000), Math.floor((dayKey % 10_000) / 100) - 1, dayKey % 100));
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(d)
    .replace(',', '');
}

const client = createPublicClient({ chain: xLayerTestnet, transport: xLayerTransport() });

/** For days committed but not yet in the publish ledger: has the oracle got a reading for them? */
function usePendingOnChain(oracle: Address | undefined, dayKeys: number[]): Record<number, boolean> {
  const [state, setState] = useState<Record<number, boolean>>({});
  const key = dayKeys.join(',');
  useEffect(() => {
    const days = key ? key.split(',').map(Number) : [];
    if (!oracle || days.length === 0) return;
    let alive = true;
    const metricId = keccak256(toBytes(METRIC));
    void Promise.all(
      days.map(async (dayKey) => {
        try {
          const raw = (await client.readContract({ address: oracle, abi: gridOracleAbi, functionName: 'getReading', args: [metricId, dayKey] })) as
            | { publishedAt: bigint }
            | readonly unknown[];
          const publishedAt = Array.isArray(raw) ? (raw[6] as bigint) : (raw as { publishedAt: bigint }).publishedAt;
          return [dayKey, publishedAt > 0n] as const;
        } catch {
          return [dayKey, false] as const;
        }
      }),
    ).then((pairs) => {
      if (alive) setState(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
  }, [oracle, key]);
  return state;
}

function Badge({ row }: { row: VerifiedRow }) {
  const s = row.verification.status;
  if (s === 'VERIFIED' || s === 'LAST_VERIFIED')
    return (
      <span className="badge" title="The value and source fingerprint on X Layer match this file">
        <i />
        Matches the chain
      </span>
    );
  if (s === 'MISMATCH')
    return (
      <span className="badge bad">
        <i />
        Does not match
      </span>
    );
  return (
    <span className="badge wait">
      <i />
      Checking
    </span>
  );
}

/**
 * Proof of every price: the latest published day, how a price settles, and
 * every published day, each checked live against the reading on X Layer
 * (lib/feed-data.ts), with the record, the source file's fingerprint and the
 * contract for anyone who wants to look for themselves.
 */
export function ProofPage() {
  const feed = useFeedData();
  const records = useCommittedRecords(METRIC);
  const addresses = useAddresses();
  const { markets } = useMarkets();
  const oracle = addresses?.GridOracle as Address | undefined;
  const rows = useMemo(() => [...feed.rows].sort((a, b) => b.record.dayKey - a.record.dayKey), [feed.rows]);
  const latest = rows[0];
  const pending = useMemo(() => {
    if (!records) return [];
    const newest = latest?.record.dayKey ?? 0;
    return records.filter((r) => !r.txHash && r.dayKey > newest).sort((a, b) => b.dayKey - a.dayKey);
  }, [records, latest]);
  const onChain = usePendingOnChain(
    oracle,
    pending.map((p) => p.dayKey),
  );
  const questions = latest && markets ? markets.filter((m) => m.metricId === METRIC && m.dayKey === latest.record.dayKey).sort((a, b) => a.threshold - b.threshold) : [];
  const [open, setOpen] = useState<number | null>(null);

  return (
    <div className="page page-body enter">
      <div className="wrap">
        <div className="phead">
          <div>
            <p className="kicker">Proof</p>
            <h1>Every price, in public.</h1>
          </div>
          <p className="lede">
            Each day&apos;s price comes from the Texas grid operator&apos;s own figures. It is published on chain and left open for
            an hour so anyone can check it before it becomes final. This page checks every published day against the chain as you
            read it.
          </p>
        </div>
        <Reveal className="latest">
          {latest ? (
            <>
              <div>
                <Badge row={latest} />
                <span className="muted">{dayLong(latest.record.dayKey)}</span>
                <span className="big">{usd(latest.record.value / 100)}</span>
                <span className="muted">day average per MWh, North Hub</span>
              </div>
              <div>
                {latest.record.txHash && (
                  <div className="row">
                    <span>Record</span>
                    <a className="lnk" href={explorerTxUrl(latest.record.txHash)} rel="noopener" target="_blank">
                      View on the explorer ↗
                    </a>
                  </div>
                )}
                <div className="row">
                  <span>Source file fingerprint</span>
                  <span title={latest.record.sourceHash}>{short(latest.record.sourceHash)}</span>
                </div>
                {questions.map((m) => {
                  const yes = latest.record.value > m.threshold;
                  return (
                    <div className="row" key={m.address}>
                      <span>Above {usd(m.threshold / 100).replace('.00', '')}?</span>
                      <span className={yes ? 'yes' : 'no'}>{yes ? 'Yes' : 'No'}</span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div>
              <span className="muted">{feed.loading ? 'Reading the published prices…' : 'No published prices yet.'}</span>
            </div>
          )}
        </Reveal>
        <Reveal as="ol" className="steps">
          <li>
            <b>The grid reports</b>
            <span>The grid operator publishes 24 hourly prices for North Hub.</span>
          </li>
          <li>
            <b>We publish the average</b>
            <span>The day&apos;s average goes on chain with a fingerprint of the source file.</span>
          </li>
          <li>
            <b>An hour to check</b>
            <span>Anyone can compare it with the grid&apos;s own file before it is final.</span>
          </li>
          <li>
            <b>Questions settle</b>
            <span>Yes / No questions and options for that day pay out on the final price.</span>
          </li>
        </Reveal>
        <section aria-label="Published prices">
          <div className="pos-head">
            <h3>Published prices</h3>
            <span className="muted" style={{ fontSize: 14 }}>
              Select a day for the technical record.
            </span>
          </div>
          <div className="plist">
            {pending.map((p) => (
              <div className="prow" key={p.dayKey}>
                <button disabled type="button">
                  <span>{dayLong(p.dayKey)}</span>
                  <span className="v">{usd(p.value / 100)}</span>
                  <span className="s">
                    <span className="badge wait">
                      <i />
                      {onChain[p.dayKey] ? 'On chain, final soon' : 'Waiting to publish'}
                    </span>
                  </span>
                  <span />
                </button>
              </div>
            ))}
            {rows.map((r) => {
              const isOpen = open === r.record.dayKey;
              return (
                <div className="prow" data-open={isOpen} key={r.record.dayKey}>
                  <button aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.record.dayKey)} type="button">
                    <span>{dayLong(r.record.dayKey)}</span>
                    <span className="v">{usd(r.record.value / 100)}</span>
                    <span className="s">
                      <Badge row={r} />
                    </span>
                    <svg aria-hidden fill="none" height="14" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 14 14" width="14">
                      <path d="M3 5l4 4 4-4" />
                    </svg>
                  </button>
                  <div className="pdet">
                    <div>
                      <dl>
                        {r.record.txHash && (
                          <>
                            <dt>Record</dt>
                            <dd>
                              <a href={explorerTxUrl(r.record.txHash)} rel="noopener" target="_blank">
                                {r.record.txHash}
                              </a>
                            </dd>
                          </>
                        )}
                        <dt>Source file fingerprint</dt>
                        <dd>{r.record.sourceHash}</dd>
                        {oracle && (
                          <>
                            <dt>Price contract</dt>
                            <dd>
                              <a href={explorerAddressUrl(oracle)} rel="noopener" target="_blank">
                                {oracle}
                              </a>
                            </dd>
                          </>
                        )}
                        <dt>Feed</dt>
                        <dd>
                          {METRIC}, day {r.record.dayKey}
                        </dd>
                      </dl>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function Reveal({ className, children, as = 'div' }: { className: string; children: React.ReactNode; as?: 'div' | 'ol' }) {
  const ref = useRef<HTMLDivElement & HTMLOListElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.classList.add('revealed');
      return;
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          el.classList.add('revealed');
          io.disconnect();
        }
      },
      { threshold: 0.08 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const Tag = as;
  return (
    <Tag className={className} data-reveal ref={ref}>
      {children}
    </Tag>
  );
}
