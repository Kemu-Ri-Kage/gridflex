'use client';

import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, Clock3, History, ShieldCheck } from 'lucide-react';

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { xLayerTestnet } from '@/lib/contracts';
import { formatElapsed } from '@/lib/feed-verification';
import { useFeedData, type CommittedRecord, type VerifiedRow } from '@/lib/feed-data';

function toDollars(rawValue: number): string {
  const dollars = rawValue / 100;
  const sign = dollars < 0 ? '-' : dollars > 0 ? '+' : '';
  return `${sign}$${Math.abs(dollars).toFixed(2)}`;
}

const heroChartConfig = {
  value: { label: 'West–North basis ($/MWh)', color: '#a8ff3e' },
} satisfies ChartConfig;

const secondaryChartConfig = {
  value: { label: 'North Hub day-ahead ($/MWh)', color: '#38bdf8' },
} satisfies ChartConfig;

function BasisChart({ series }: { series: CommittedRecord[] }) {
  const data = series.map((record) => ({ marketDay: record.marketDay, value: record.value / 100 }));
  return (
    <ChartContainer config={heroChartConfig} className="aspect-auto h-64 w-full">
      <AreaChart data={data} margin={{ left: 8, right: 8, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeOpacity={0.08} />
        <XAxis
          dataKey="marketDay"
          tickLine={false}
          axisLine={false}
          minTickGap={48}
          tick={{ fontSize: 11 }}
        />
        <YAxis tickLine={false} axisLine={false} width={48} tick={{ fontSize: 11 }} />
        {/* shared/feed-spec.md §5: the zero line is the story - a signed spread, not a price. */}
        <ReferenceLine y={0} stroke="#ffffff" strokeOpacity={0.35} strokeWidth={1.5} />
        <ChartTooltip content={<ChartTooltipContent labelKey="marketDay" />} />
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--color-value)"
          fill="var(--color-value)"
          fillOpacity={0.18}
          strokeWidth={2}
          dot={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

function HbNorthChart({ series }: { series: CommittedRecord[] }) {
  const data = series.map((record) => ({ marketDay: record.marketDay, value: record.value / 100 }));
  return (
    <ChartContainer config={secondaryChartConfig} className="aspect-auto h-36 w-full">
      <LineChart data={data} margin={{ left: 8, right: 8, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeOpacity={0.08} />
        <XAxis
          dataKey="marketDay"
          tickLine={false}
          axisLine={false}
          minTickGap={48}
          tick={{ fontSize: 11 }}
        />
        <YAxis tickLine={false} axisLine={false} width={40} tick={{ fontSize: 11 }} />
        <ChartTooltip content={<ChartTooltipContent labelKey="marketDay" />} />
        <Line
          type="monotone"
          dataKey="value"
          stroke="var(--color-value)"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ChartContainer>
  );
}

/**
 * shared/feed-spec.md §4: exactly one indicator per row, one of four states.
 *
 * `now` is passed in rather than read via Date.now() here so this component
 * stays pure during render - the impure clock read lives in FeedPanel's
 * effect below, not in render.
 */
function VerificationBadge({ row, now }: { row: VerifiedRow; now: number }) {
  const { status, lastVerifiedAt } = row.verification;
  const ago = lastVerifiedAt !== null ? formatElapsed(now - lastVerifiedAt) : null;

  switch (status) {
    case 'VERIFIED':
      return (
        <Badge variant="outline" className="border-[#a8ff3e]/30 text-[#a8ff3e]">
          <ShieldCheck className="size-3" />
          verified {ago} ago
        </Badge>
      );
    case 'LAST_VERIFIED':
      return (
        <Badge variant="secondary" className="text-slate-400">
          <History className="size-3" />
          last verified {ago} ago
        </Badge>
      );
    case 'MISMATCH':
      return (
        <Badge variant="destructive">
          <AlertTriangle className="size-3" />
          MISMATCH
        </Badge>
      );
    case 'UNVERIFIED':
    default:
      return (
        <Badge variant="secondary" className="text-slate-500">
          <Clock3 className="size-3" />
          not yet verified
        </Badge>
      );
  }
}

function explorerTxUrl(txHash: string): string {
  return `${xLayerTestnet.blockExplorers.default.url}/tx/${txHash}`;
}

export function FeedPanel() {
  const { loading, totalLocalCandidates, submittedCount, heroSeries, secondarySeries, rows } =
    useFeedData();

  // "now" lives in state, updated from an effect, so render itself stays
  // pure - "verified Xs ago" still advances without a full refetch.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="space-y-5">
      <Card className="border-white/8 bg-card/80 shadow-[0_24px_80px_rgba(0,0,0,.2)] ring-0">
        <CardHeader className="border-b border-white/8 pb-4">
          <div>
            <CardDescription className="font-mono text-xs uppercase tracking-[0.14em] text-slate-500">
              West–North day-ahead basis
            </CardDescription>
            <CardTitle className="mt-1 text-lg font-semibold text-white">
              {loading
                ? 'Loading committed history…'
                : `${submittedCount} of ${totalLocalCandidates} metric-days published so far`}
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          <BasisChart series={heroSeries} />
        </CardContent>
      </Card>

      <Card className="border-white/8 bg-card/70 ring-0">
        <CardHeader className="border-b border-white/8 pb-4">
          <div>
            <CardTitle className="text-base text-white">Verified ERCOT readings</CardTitle>
            <CardDescription>
              Every row below is a fresh on-chain read, compared live against the committed
              source file.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="pt-1">
          {rows.length === 0 ? (
            <p className="py-6 text-sm text-slate-500">
              {loading
                ? 'Loading…'
                : 'Nothing published on-chain yet — check back once publish.py --live has run.'}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Metric</TableHead>
                  <TableHead>Day</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={`${row.metricId}:${row.record.dayKey}`}>
                    <TableCell>
                      <div className="font-medium text-slate-200">{row.metricLabel}</div>
                      <div className="font-mono text-xs text-slate-600">{row.metricId}</div>
                    </TableCell>
                    <TableCell className="text-slate-300">{row.record.marketDay}</TableCell>
                    <TableCell className="font-mono text-white">
                      {toDollars(row.record.value)}/MWh
                    </TableCell>
                    <TableCell>
                      <a
                        className="font-mono text-xs text-cyan-300 hover:underline"
                        href={row.record.txHash ? explorerTxUrl(row.record.txHash) : undefined}
                        title={`sha256 ${row.record.sourceHash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        sha256 {row.record.sourceHash.slice(0, 8)}…
                      </a>
                    </TableCell>
                    <TableCell>
                      <VerificationBadge row={row} now={now} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="border-white/8 bg-card/60 ring-0">
        <CardHeader className="border-b border-white/8 pb-3">
          <CardDescription className="font-mono text-xs uppercase tracking-[0.14em] text-slate-500">
            North Hub day-ahead average
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <HbNorthChart series={secondarySeries} />
        </CardContent>
      </Card>
    </div>
  );
}
