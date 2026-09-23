'use client';

import * as React from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis, usePlotArea, useYAxisScale } from 'recharts';

import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import { formatPrice } from '@/lib/format';
import { dayLabel, useMarkets, type Market } from '@/lib/markets';
import { useCommittedRecords } from '@/lib/site-data';
import { niceScale, pastFrequency, spreadLabels, strikeLines, type StrikeLine } from '@/lib/strike-ladder';

type Range = '90d' | 'year';

const RANGES: { id: Range; label: string }[] = [
  { id: '90d', label: '90 days' },
  { id: 'year', label: 'Full year' },
];

/** Published days in the default range. */
const RECENT_DAYS = 90;

/** The two past-frequency windows, in published days. */
const WINDOWS = [30, 90] as const;

/** Label font size and the minimum vertical gap between two strike labels (px). */
const LABEL_FONT = 10;
const LABEL_GAP = 14;
/** The right price axis, wide enough for a "$45.00" strike tag. */
const AXIS_WIDTH = 50;

const chartConfig = {
  value: { label: 'Texas power price', color: 'var(--chart-1)' },
} satisfies ChartConfig;

/** The in-pane label: which listed days settle at this strike. */
function strikeDays(line: StrikeLine): string {
  const days = line.dayKeys.map((dayKey) => dayLabel(dayKey)).join(', ');
  return line.selected ? `Strike · ${days}` : days;
}

/**
 * Where each strike line and its two labels sit, from the chart's own y
 * scale. Each label is spread so a ladder $2 apart stays readable: the
 * price as a tag on the right axis, and the days it settles at the left
 * edge, where the oldest prices are - never over the latest ones.
 */
function useStrikeGeometry(lines: StrikeLine[]) {
  const scale = useYAxisScale();
  const plot = usePlotArea();
  if (!scale || !plot) return null;
  const top = plot.y;
  const bottom = plot.y + plot.height;
  const ys = lines.map((line) => scale(line.threshold / 100) ?? bottom);
  const spread = (at: number[]) => spreadLabels(at, LABEL_GAP, top + LABEL_GAP / 2, bottom - LABEL_GAP / 2);
  return {
    plot,
    ys,
    tagYs: spread(ys),
    dayYs: spread(ys.map((y) => y - LABEL_GAP / 2)),
  };
}

/** A price-axis tick, left out where a strike tag covers it. */
function PriceTick({
  lines,
  x,
  y,
  payload,
}: {
  lines: StrikeLine[];
  x?: number;
  y?: number;
  payload?: { value: number };
}) {
  const geometry = useStrikeGeometry(lines);
  if (x === undefined || y === undefined || !payload) return null;
  if (geometry?.tagYs.some((tagY) => Math.abs(tagY - y) < LABEL_GAP)) return null;
  return (
    <text x={x} y={y} dy="0.32em" fill="var(--muted-foreground)" fontSize={11}>
      ${payload.value}
    </text>
  );
}

/**
 * The listed strikes, drawn inside the chart's SVG from its own y scale: a
 * very light shade over the region above the selected strike (where a day
 * settles YES), then every strike as a dashed line - the selected one in
 * --warning, the others faint.
 */
function StrikeLadder({ lines, layer }: { lines: StrikeLine[]; layer: 'shade' | 'lines' }) {
  const geometry = useStrikeGeometry(lines);
  if (!geometry) return null;
  const { plot, ys, tagYs, dayYs } = geometry;
  const top = plot.y;
  const bottom = plot.y + plot.height;
  const right = plot.x + plot.width;

  if (layer === 'shade') {
    const index = lines.findIndex((line) => line.selected);
    if (index === -1) return null;
    const y = Math.min(Math.max(ys[index], top), bottom);
    return (
      <rect
        x={plot.x}
        y={top}
        width={plot.width}
        height={y - top}
        fill="var(--warning)"
        fillOpacity={0.05}
        pointerEvents="none"
      />
    );
  }

  // The selected line is drawn last, so it sits on top where lines cross.
  const order = lines.map((_, i) => i).sort((a, b) => Number(lines[a].selected) - Number(lines[b].selected));

  return (
    <g pointerEvents="none">
      {order.map((i) => {
        const line = lines[i];
        const color = line.selected ? 'var(--warning)' : 'var(--muted-foreground)';
        return (
          <g key={line.threshold}>
            <line
              x1={plot.x}
              x2={right}
              y1={ys[i]}
              y2={ys[i]}
              stroke={color}
              strokeOpacity={line.selected ? 1 : 0.45}
              strokeWidth={1}
              strokeDasharray="4 3"
            />
            <text
              x={plot.x + 4}
              y={dayYs[i]}
              dominantBaseline="central"
              fill={color}
              fillOpacity={line.selected ? 1 : 0.75}
              fontSize={LABEL_FONT}
              // A halo in the background colour keeps the label legible
              // over the price line without a box hiding the prices.
              stroke="var(--background)"
              strokeWidth={3}
              paintOrder="stroke"
            >
              {strikeDays(line)}
            </text>
            <rect
              x={right + 1}
              y={tagYs[i] - LABEL_GAP / 2 + 1}
              width={AXIS_WIDTH - 2}
              height={LABEL_GAP - 2}
              fill={line.selected ? 'var(--warning)' : 'var(--background)'}
              stroke={line.selected ? 'none' : 'var(--border)'}
              rx={2}
            />
            <text
              x={right + AXIS_WIDTH / 2}
              y={tagYs[i]}
              dominantBaseline="central"
              textAnchor="middle"
              fill={line.selected ? 'var(--background)' : 'var(--muted-foreground)'}
              fontSize={LABEL_FONT}
            >
              {formatPrice(line.threshold)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function Tooltip({ active, payload }: { active?: boolean; payload?: { payload?: { dayKey: number; cents: number } }[] }) {
  const point = active ? payload?.[0]?.payload : undefined;
  if (!point) return null;
  return (
    <div className="border border-border bg-card px-2 py-1 font-mono text-xs tabular-nums">
      <div className="text-muted-foreground">{dayLabel(point.dayKey, true)}</div>
      <div className="text-foreground">{formatPrice(point.cents, 'MWh')}</div>
    </div>
  );
}

/**
 * Days above the selected strike, before the market's own day, as a plain
 * count. It is shown as a count of days, never a percentage, so it can't be
 * read as a probability or set against the YES price (design-brief.md §9).
 */
function PastFrequencyPanel({
  records,
  selected,
  marketsLoading,
}: {
  records: { dayKey: number; value: number }[] | null;
  selected: Market | undefined;
  marketsLoading: boolean;
}) {
  let body: React.ReactNode;
  if (!selected && !marketsLoading) {
    body = <p className="text-muted-foreground">No market selected.</p>;
  } else if (!selected || !records) {
    body = <p className="text-muted-foreground">Loading…</p>;
  } else {
    const counts = WINDOWS.map((window) => ({
      window,
      ...pastFrequency(records, selected.threshold, selected.dayKey, window),
    }));
    const lastDayKey = counts[counts.length - 1].lastDayKey;
    body =
      lastDayKey === null ? (
        <p className="text-muted-foreground">No published prices before this day.</p>
      ) : (
        <>
          <div className="text-muted-foreground">Days above {formatPrice(selected.threshold)}</div>
          <dl className="mt-1.5 grid grid-cols-[auto_auto] gap-x-4 gap-y-1 lg:grid-cols-1 lg:gap-y-2">
            {counts.map(({ window, above, days }) => (
              <div className="flex items-baseline justify-between gap-3 lg:block" key={window}>
                <dt className="text-muted-foreground">Last {window} days</dt>
                <dd className="font-mono tabular-nums text-foreground lg:mt-0.5 lg:text-sm">
                  {above} of {days}
                </dd>
              </div>
            ))}
          </dl>
          <div className="mt-1.5 font-mono tabular-nums text-muted-foreground lg:mt-3">
            To {dayLabel(lastDayKey, true)}
          </div>
        </>
      );
  }
  return (
    <div className="border-b border-border px-3 py-2 text-xs lg:w-40 lg:shrink-0 lg:border-r lg:border-b-0 lg:py-3">
      <div className="mb-1 font-mono uppercase tracking-[0.12em] text-muted-foreground lg:mb-2">
        Past frequency
      </div>
      {body}
    </div>
  );
}

/**
 * The default /trade chart: the verified daily Texas power price markets
 * settle on, one point per published day, with every listed strike drawn
 * across it (design-brief.md §9).
 */
export function SettlementPriceChart({ range }: { range: Range }) {
  const allRecords = useCommittedRecords('ERCOT_HBNORTH_DA_AVG');
  const { markets, selected } = useMarkets();

  const lines = React.useMemo(
    () => strikeLines(markets ?? [], selected?.address),
    [markets, selected?.address],
  );
  const records = range === '90d' ? allRecords?.slice(-RECENT_DAYS) : allRecords;

  let plot: React.ReactNode;
  if (!records) {
    plot = <p className="p-3 text-xs text-muted-foreground">Loading…</p>;
  } else if (records.length === 0) {
    plot = <p className="p-3 text-xs text-muted-foreground">No prices published yet.</p>;
  } else {
    const data = records.map((record) => ({
      dayKey: record.dayKey,
      day: dayLabel(record.dayKey),
      cents: record.value,
      value: record.value / 100,
    }));
    // The y range always takes in every listed strike, so no line is
    // clipped off the chart.
    const strikes = lines.map((line) => line.threshold / 100);
    const values = [...data.map((d) => d.value), ...strikes];
    const { domain, ticks } = niceScale(values);
    plot = (
      <ChartContainer config={chartConfig} className="aspect-auto h-full min-h-[300px] w-full font-mono tabular-nums">
        <LineChart data={data} margin={{ left: 4, right: 0, top: 12, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeOpacity={0.08} />
          <XAxis dataKey="day" tickLine={false} axisLine={false} minTickGap={40} tick={{ fontSize: 11 }} />
          <YAxis
            orientation="right"
            domain={domain}
            ticks={ticks}
            interval={0}
            allowDataOverflow
            tickLine={false}
            axisLine={false}
            width={AXIS_WIDTH}
            tick={<PriceTick lines={lines} />}
          />
          <StrikeLadder layer="shade" lines={lines} />
          <ChartTooltip content={<Tooltip />} cursor={{ stroke: 'var(--muted-foreground)', strokeOpacity: 0.4 }} />
          <Line
            type="linear"
            dataKey="value"
            stroke="var(--color-value)"
            strokeWidth={1.5}
            dot={{ r: 1.75, fill: 'var(--color-value)', strokeWidth: 0 }}
            activeDot={{ r: 3, fill: 'var(--color-value)', stroke: 'var(--background)', strokeWidth: 1.5 }}
            isAnimationActive={false}
          />
          <StrikeLadder layer="lines" lines={lines} />
        </LineChart>
      </ChartContainer>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-[360px] flex-1 flex-col lg:flex-row">
        <PastFrequencyPanel marketsLoading={markets === null} records={allRecords} selected={selected} />
        <div className="relative min-h-[300px] min-w-0 flex-1 px-1 pt-2">{plot}</div>
      </div>
      <div className="border-t border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        Daily Texas power price, $/MWh · the verified price markets settle on
      </div>
    </div>
  );
}

export { RANGES as SETTLEMENT_RANGES, type Range as SettlementRange };
