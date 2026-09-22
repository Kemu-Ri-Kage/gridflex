'use client';

import * as React from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceDot,
  XAxis,
  YAxis,
} from 'recharts';

import { Reveal } from '@/components/landing/scroll-motion';
import { SectionHeading } from '@/components/landing/section-heading';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { formatPrice } from '@/lib/format';
import { dayLabel } from '@/lib/markets';
import { priceSummary } from '@/lib/price-summary';
import { useCommittedRecords } from '@/lib/site-data';

type View = '90d' | 'year';

const VIEWS: { id: View; label: string }[] = [
  { id: '90d', label: '90 days' },
  { id: 'year', label: 'Full year' },
];

/** Published days shown in the default view. */
const RECENT_DAYS = 90;

const chartConfig = {
  value: { label: 'Texas power price ($/MWh)', color: 'var(--chart-1)' },
} satisfies ChartConfig;

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="border border-border bg-card p-5">
      <div className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-foreground sm:text-4xl">
        {value}
      </div>
      {note && <div className="mt-2 font-mono text-xs tabular-nums text-muted-foreground">{note}</div>}
    </div>
  );
}

/**
 * The page's main chart: the daily Texas power price over time, with the
 * normal range shaded. Defaults to the last 90 published days, where the
 * normal range is legible; the full year shows the peak, marked. Values are
 * stated once, in the stats above it - the chart shows shape, not a second
 * copy of the numbers.
 */
function PriceChart({ view }: { view: View }) {
  const allRecords = useCommittedRecords('ERCOT_HBNORTH_DA_AVG');
  const { low, high, peak } = priceSummary.range;
  const records = view === '90d' ? allRecords?.slice(-RECENT_DAYS) : allRecords;

  if (!records) {
    return <p className="py-10 text-sm text-muted-foreground">Loading…</p>;
  }
  if (records.length === 0) {
    return <p className="py-10 text-sm text-muted-foreground">No prices published yet.</p>;
  }

  const data = records.map((record) => ({
    day: dayLabel(record.dayKey, true),
    value: record.value / 100,
  }));
  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
      <LineChart data={data} margin={{ left: 8, right: 8, top: 16, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeOpacity={0.08} />
        <XAxis dataKey="day" tickLine={false} axisLine={false} minTickGap={48} tick={{ fontSize: 11 }} />
        <YAxis tickLine={false} axisLine={false} width={40} tick={{ fontSize: 11 }} />
        <ReferenceArea
          y1={low / 100}
          y2={high / 100}
          fill="var(--foreground)"
          fillOpacity={0.2}
          strokeOpacity={0}
          ifOverflow="extendDomain"
        />
        <ChartTooltip content={<ChartTooltipContent labelKey="day" />} />
        <Line type="monotone" dataKey="value" stroke="var(--color-value)" strokeWidth={1.5} dot={false} />
        {records.some((record) => record.dayKey === peak.dayKey) && (
          <ReferenceDot
            x={dayLabel(peak.dayKey, true)}
            y={peak.value / 100}
            r={3}
            fill="var(--chart-1)"
            stroke="var(--background)"
            strokeWidth={1.5}
          />
        )}
      </LineChart>
    </ChartContainer>
  );
}

export function PriceRange() {
  const { days, low, high, peak } = priceSummary.range;
  const [view, setView] = React.useState<View>('90d');

  return (
    <section className="border-b border-border py-16 sm:py-24" id="prices">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <Reveal>
          <SectionHeading index="01" title="Normal range" />
          <p className="mb-10 max-w-2xl text-lg leading-8 text-muted-foreground">
            Prices are per megawatt-hour (MWh), roughly what a thousand homes use in an hour.
          </p>
          <div className="mb-5 grid gap-5 sm:grid-cols-2">
            <Stat
              label={`Normal day · middle 80% of ${days} days`}
              value={`${formatPrice(low)}–${formatPrice(high)}`}
            />
            {/* peak.timesMedian: the peak day over the median published day,
                rounded - computed in build_feed_data.py's price_range(). */}
            <Stat
              label={`Exception · ${dayLabel(peak.dayKey, true)}`}
              value={formatPrice(peak.value)}
              note={`about ${peak.timesMedian}× the median day`}
            />
          </div>
          <div className="border border-border bg-card p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
                Texas power price · daily
              </div>
              <div className="flex gap-1">
                {VIEWS.map((v) => (
                  <button
                    aria-pressed={view === v.id}
                    className={
                      'border px-2.5 py-1 font-mono text-xs transition-colors duration-200 ' +
                      (view === v.id
                        ? 'border-foreground text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground')
                    }
                    key={v.id}
                    onClick={() => setView(v.id)}
                    type="button"
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
            <PriceChart view={view} />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
