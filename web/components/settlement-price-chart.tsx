'use client';

import * as React from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis, usePlotArea, useYAxisScale } from 'recharts';

import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import { formatPrice } from '@/lib/format';
import { dayLabel, useMarkets, type Market } from '@/lib/markets';
import { bodyEdges, candleDirection, scaleTop, skippedInRange, type PriceCandle } from '@/lib/price-candles';
import { useCommittedRecords, usePriceCandles } from '@/lib/site-data';
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
  value: { label: 'Daily average', color: 'var(--chart-1)' },
} satisfies ChartConfig;

/** The caret marking a high above the scale, in px. */
const CARET_WIDTH = 9;
const CARET_HEIGHT = 7;

/**
 * An upward caret with its tip at (x, y): marks a wick whose high is above
 * the top of the scale. A halo in the background colour keeps neighbouring
 * wicks from running into it.
 */
function SpikeCaret({ color, x, y }: { color: string; x: number; y: number }) {
  const half = CARET_WIDTH / 2;
  return (
    <path
      d={`M${x - half} ${y + CARET_HEIGHT}L${x} ${y}L${x + half} ${y + CARET_HEIGHT}Z`}
      fill={color}
      paintOrder="stroke"
      stroke="var(--background)"
      strokeLinejoin="round"
      strokeWidth={1.5}
    />
  );
}

/** A candle's colour: --up when the day closed above its open, --down below. */
const DIRECTION_COLOR = {
  up: 'var(--up)',
  down: 'var(--down)',
  flat: 'var(--muted-foreground)',
} as const;

interface ChartPoint {
  dayKey: number;
  day: string;
  /** The daily average in cents, the value markets settle on. */
  cents: number;
  value: number;
  candle: PriceCandle | null;
  /** [low, high] in dollars, the candle's wick; null with no candle. */
  range: [number, number] | null;
}

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
      {payload.value < 0 ? `-$${-payload.value}` : `$${payload.value}`}
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

/**
 * One day's candle, drawn in the box recharts gives its [low, high] bar: a
 * 1px wick from high to low and a body from open to close, both in the
 * day's --up/--down colour. A high past the top of the scale is drawn to
 * the top edge and marked with a small caret there.
 */
function CandleShape({
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  payload,
}: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: ChartPoint;
}) {
  const plot = usePlotArea();
  const candle = payload?.candle;
  if (!candle || !plot) return null;
  const top = Math.min(y, y + height);
  const bottom = top + Math.abs(height);
  const edges = bodyEdges(candle, top, Math.abs(height));
  const color = DIRECTION_COLOR[candleDirection(candle)];
  const mid = x + width / 2;
  const bodyWidth = Math.max(1, width);
  const clipped = top < plot.y;
  // A clipped wick stops short of its caret, so the break reads as "this
  // goes higher" rather than as a line that happens to touch the edge.
  const wickTop = clipped ? plot.y + CARET_HEIGHT + 2 : Math.max(top, plot.y);
  return (
    <g pointerEvents="none">
      <line x1={mid} x2={mid} y1={wickTop} y2={bottom} stroke={color} strokeWidth={1} />
      {clipped && <SpikeCaret color={color} x={mid} y={plot.y} />}
      <rect
        x={mid - bodyWidth / 2}
        y={Math.max(edges.top, plot.y)}
        width={bodyWidth}
        height={Math.max(1, edges.bottom - Math.max(edges.top, plot.y))}
        fill={color}
      />
    </g>
  );
}

function Tooltip({ active, payload }: { active?: boolean; payload?: { payload?: ChartPoint }[] }) {
  const point = active ? payload?.[0]?.payload : undefined;
  if (!point) return null;
  const { candle } = point;
  const rows: [string, number][] = candle
    ? [
        ['Open', candle.open],
        ['High', candle.high],
        ['Low', candle.low],
        ['Close', candle.close],
      ]
    : [];
  return (
    <div className="border border-border bg-card px-2 py-1 font-mono text-xs tabular-nums">
      <div className="text-muted-foreground">{dayLabel(point.dayKey, true)}</div>
      <dl className="mt-0.5 grid grid-cols-[auto_auto] gap-x-3">
        {rows.map(([label, cents]) => (
          <React.Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right text-foreground">{formatPrice(cents)}</dd>
          </React.Fragment>
        ))}
        <dt className="text-[var(--color-value)]">Average</dt>
        <dd className="text-right text-foreground">{formatPrice(point.cents, 'MWh')}</dd>
      </dl>
    </div>
  );
}

/** What the two marks are: the day's hourly range, and the price it settles on. */
function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 pb-1 font-mono text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <svg aria-hidden="true" height="12" width="9">
          <line stroke="var(--up)" x1="2" x2="2" y1="0" y2="12" />
          <rect fill="var(--up)" height="6" width="3" x="0.5" y="3" />
          <line stroke="var(--down)" x1="7" x2="7" y1="1" y2="11" />
          <rect fill="var(--down)" height="5" width="3" x="5.5" y="4" />
        </svg>
        Candle · 24 hourly prices: open, high, low, close
      </span>
      <span className="flex items-center gap-1.5">
        <svg aria-hidden="true" height="12" width="14">
          <line stroke="var(--chart-1)" strokeWidth="1.5" x1="0" x2="14" y1="6" y2="6" />
        </svg>
        Line · daily average, the settlement price
      </span>
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
 * The default /trade chart: one candle per published day from its 24
 * hourly prices, with the verified daily average markets settle on drawn
 * over them as a line, and every listed strike across both
 * (design-brief.md §9).
 */
export function SettlementPriceChart({ range }: { range: Range }) {
  const allRecords = useCommittedRecords('ERCOT_HBNORTH_DA_AVG');
  const priceCandles = usePriceCandles();
  const { markets, selected } = useMarkets();

  const lines = React.useMemo(
    () => strikeLines(markets ?? [], selected?.address),
    [markets, selected?.address],
  );
  const records = range === '90d' ? allRecords?.slice(-RECENT_DAYS) : allRecords;
  const candleByDay = React.useMemo(
    () => new Map((priceCandles?.candles ?? []).map((candle) => [candle.dayKey, candle])),
    [priceCandles],
  );
  const skipped =
    records && records.length > 0 && priceCandles
      ? skippedInRange(priceCandles.skipped, records[0].dayKey, records[records.length - 1].dayKey)
      : 0;

  let plot: React.ReactNode;
  // Highs above the top of the scale, and that top in dollars.
  let spikes = 0;
  let scaleCap = 0;
  if (!records || !priceCandles) {
    plot = <p className="p-3 text-xs text-muted-foreground">Loading…</p>;
  } else if (records.length === 0) {
    plot = <p className="p-3 text-xs text-muted-foreground">No prices published yet.</p>;
  } else {
    const data: ChartPoint[] = records.map((record) => {
      const candle = candleByDay.get(record.dayKey) ?? null;
      return {
        dayKey: record.dayKey,
        day: dayLabel(record.dayKey),
        cents: record.value,
        value: record.value / 100,
        candle,
        range: candle ? [candle.low / 100, candle.high / 100] : null,
      };
    });
    // The y range always takes in every daily average, every low and every
    // listed strike, so no line is clipped off the chart. Highs count up to
    // scaleTop(): a spike far above them runs off the top, marked.
    const strikes = lines.map((line) => line.threshold / 100);
    const averages = data.map((d) => d.value);
    const lows = data.flatMap((d) => (d.range ? [d.range[0]] : []));
    const top = scaleTop([...averages, ...strikes], data.flatMap((d) => (d.range ? [d.range[1]] : [])));
    const values = [...averages, ...lows, ...strikes, top];
    const { domain, ticks } = niceScale(values);
    spikes = data.filter((d) => d.range && d.range[1] > domain[1]).length;
    scaleCap = domain[1];
    plot = (
      <ChartContainer config={chartConfig} className="aspect-auto h-full min-h-[300px] w-full font-mono tabular-nums">
        <ComposedChart barCategoryGap="25%" data={data} margin={{ left: 4, right: 0, top: 12, bottom: 0 }}>
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
          <ChartTooltip content={<Tooltip />} cursor={{ fill: 'var(--muted-foreground)', fillOpacity: 0.1 }} />
          <Bar dataKey="range" shape={<CandleShape />} isAnimationActive={false} />
          <Line
            type="linear"
            dataKey="value"
            stroke="var(--color-value)"
            strokeWidth={1.25}
            dot={false}
            activeDot={{ r: 2.5, fill: 'var(--color-value)', stroke: 'var(--background)', strokeWidth: 1 }}
            isAnimationActive={false}
          />
          <StrikeLadder layer="lines" lines={lines} />
        </ComposedChart>
      </ChartContainer>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-[360px] flex-1 flex-col lg:flex-row">
        <PastFrequencyPanel marketsLoading={markets === null} records={allRecords} selected={selected} />
        <div className="flex min-h-[300px] min-w-0 flex-1 flex-col pt-2">
          <Legend />
          <div className="relative min-h-[300px] flex-1 px-1">{plot}</div>
        </div>
      </div>
      <div className="border-t border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        Daily Texas power price, $/MWh · the verified price markets settle on
        {skipped > 0 && ` · ${skipped} ${skipped === 1 ? 'day' : 'days'} without 24 hours not drawn`}
        {spikes > 0 && (
          <div className="mt-0.5 flex items-center gap-1.5">
            <svg aria-hidden="true" className="shrink-0" height={CARET_HEIGHT + 2} width={CARET_WIDTH + 2}>
              <SpikeCaret color="var(--foreground)" x={CARET_WIDTH / 2 + 1} y={1} />
            </svg>
            Scale capped at ${scaleCap} so the strikes stay readable · {spikes} higher{' '}
            {spikes === 1 ? 'spike' : 'spikes'} marked, real high on hover
          </div>
        )}
      </div>
    </div>
  );
}

export { RANGES as SETTLEMENT_RANGES, type Range as SettlementRange };
