'use client';

import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
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
import { formatCount, formatPrice } from '@/lib/format';
import { useFeedData, HERO_METRIC, type CommittedRecord, type VerifiedRow } from '@/lib/feed-data';

const heroChartConfig = {
  value: { label: 'West–North basis ($/MWh)', color: 'var(--chart-2)' },
} satisfies ChartConfig;

const secondaryChartConfig = {
  value: { label: 'North Hub day-ahead ($/MWh)', color: 'var(--chart-1)' },
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
        {/* shared/feed-spec.md §5: "visually emphasized (not just an axis
            gridline) - crossing it is the story" - so this must not share
            the CartesianGrid's border colour/opacity above. */}
        <ReferenceLine y={0} stroke="var(--foreground)" strokeOpacity={0.55} strokeWidth={1.5} />
        <ChartTooltip content={<ChartTooltipContent labelKey="marketDay" />} />
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--color-value)"
          fill="var(--color-value)"
          fillOpacity={0.14}
          strokeWidth={1.5}
          dot={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

function HbNorthChart({ series }: { series: CommittedRecord[] }) {
  const data = series.map((record) => ({ marketDay: record.marketDay, value: record.value / 100, cents: record.value }));
  // The spike is real data, not an outlier to hide - annotate it rather than
  // clip the axis or log-scale, so its date and peak value are legible.
  const peak = data.reduce<(typeof data)[number] | null>(
    (max, point) => (max === null || point.value > max.value ? point : max),
    null,
  );
  return (
    <ChartContainer config={secondaryChartConfig} className="aspect-auto h-36 w-full">
      <LineChart data={data} margin={{ left: 8, right: 8, top: 24, bottom: 0 }}>
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
          strokeWidth={1.5}
          dot={false}
        />
        {peak && (
          <ReferenceDot
            x={peak.marketDay}
            y={peak.value}
            r={3}
            fill="var(--chart-1)"
            stroke="var(--background)"
            strokeWidth={1.5}
            label={{
              value: `${peak.marketDay} · ${formatPrice(peak.cents, 'MWh')}`,
              position: 'top',
              style: { fontFamily: 'var(--font-mono)', fontSize: 11, fill: 'var(--foreground)' },
            }}
          />
        )}
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
 *
 * MISMATCH is deliberately not a Badge: it renders as a solid filled block,
 * never as inline text/border colour, so it can never be mistaken for a
 * transient check failure or a passing verification pill.
 */
function VerificationBadge({ row, now }: { row: VerifiedRow; now: number }) {
  const { status, lastVerifiedAt } = row.verification;
  const ago = lastVerifiedAt !== null ? formatElapsed(now - lastVerifiedAt) : null;

  switch (status) {
    case 'VERIFIED':
      return (
        <Badge variant="outline" className="border-up/30 text-up">
          <ShieldCheck className="size-3" />
          verified {ago} ago
        </Badge>
      );
    case 'LAST_VERIFIED':
      return (
        <Badge variant="secondary" className="text-muted-foreground">
          <History className="size-3" />
          last verified {ago} ago
        </Badge>
      );
    case 'MISMATCH':
      return (
        <span className="inline-flex items-center gap-1.5 border-l-2 border-mismatch-accent bg-mismatch px-2 py-1 text-xs font-medium text-mismatch-foreground">
          <AlertTriangle className="size-3" />
          MISMATCH
        </span>
      );
    case 'UNVERIFIED':
    default:
      return (
        <Badge variant="secondary" className="text-muted-foreground/70">
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
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <div>
            <CardDescription className="font-mono text-xs uppercase tracking-[0.14em]">
              West–North day-ahead basis
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          <BasisChart series={heroSeries} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b border-border pb-4">
          <div>
            <CardTitle className="text-base text-foreground">Verified ERCOT readings</CardTitle>
            <CardDescription>
              <span className="font-mono tabular-nums">
                {submittedCount.toLocaleString('en-US')} of{' '}
                {totalLocalCandidates.toLocaleString('en-US')}
              </span>{' '}
              metric-days published.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="pt-1">
          {rows.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              {loading
                ? 'Loading…'
                : 'No readings published yet.'}
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
                {rows.map((row) => {
                  const isBasis = row.metricId === HERO_METRIC;
                  const isCount = row.metricId === 'ERCOT_HBWEST_NEG_INTERVALS';
                  const sign = Math.sign(row.record.value);
                  return (
                    <TableRow key={`${row.metricId}:${row.record.dayKey}`}>
                      <TableCell>
                        <div className="font-medium text-foreground">{row.metricLabel}</div>
                        <div className="font-mono text-xs text-muted-foreground">{row.metricId}</div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{row.record.marketDay}</TableCell>
                      <TableCell
                        className={
                          'font-mono tabular-nums ' +
                          (isBasis && sign > 0
                            ? 'text-up'
                            : isBasis && sign < 0
                              ? 'text-down'
                              : 'text-foreground')
                        }
                      >
                        {isCount
                          ? formatCount(row.record.value, 'intervals')
                          : formatPrice(row.record.value, 'MWh', isBasis)}
                      </TableCell>
                      <TableCell>
                        <a
                          className="font-mono text-xs text-chart-1 transition-colors duration-200 hover:text-foreground hover:underline"
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
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardDescription className="font-mono text-xs uppercase tracking-[0.14em]">
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
