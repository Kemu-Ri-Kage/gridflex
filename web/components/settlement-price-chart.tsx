'use client';

import * as React from 'react';
import {
  ColorType,
  createChart,
  LineSeries,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type Time,
  type WhitespaceData,
} from 'lightweight-charts';

import { formatPrice } from '@/lib/format';
import { dayLabel, useMarkets, type Market } from '@/lib/markets';
import {
  presetRange,
  priceWindow,
  skippedInRange,
  visibleIndices,
  type PriceCandle,
  type RangePreset,
} from '@/lib/price-candles';
import {
  CARET_HEIGHT,
  CARET_WIDTH,
  CandleSeriesView,
  MANUAL_CLIP,
  StrikeLadderPrimitive,
  TOP_MARGIN,
  type CandlePoint,
  type CandleStyle,
  type ScaleState,
} from '@/lib/settlement-chart-drawing';
import { useCommittedRecords, usePriceCandles } from '@/lib/site-data';
import { pastFrequency, strikeLines } from '@/lib/strike-ladder';

const RANGES: { id: RangePreset; label: string }[] = [
  { id: '90d', label: '90 days' },
  { id: 'year', label: 'Full year' },
];

/**
 * Up and down candles both filled solid, with no outline
 * (design-brief.md §9). 'hollow' outlines up candles instead; 'light'
 * fills them at reduced opacity.
 */
const CANDLE_STYLE: CandleStyle = 'filled';

/** The two past-frequency windows, in published days. */
const WINDOWS = [30, 90] as const;

/** A preset to apply; `nonce` changes on every click, so re-clicking one re-applies it. */
export interface PresetRequest {
  range: RangePreset;
  nonce: number;
}

/** What the caption reports about the days on screen. */
interface ViewStats {
  skipped: number;
  spikes: number;
  cap: number | null;
  /** The price axis has been stretched by hand, so auto-fit is off. */
  manual: boolean;
}

/** YYYYMMDD as the chart's business-day time, by string slicing. */
function chartTime(dayKey: number): string {
  const s = String(dayKey);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function dayKeyOf(time: Time): number {
  if (typeof time === 'string') return Number(time.replaceAll('-', ''));
  if (typeof time === 'number') {
    const date = new Date(time * 1000);
    return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  }
  return time.year * 10000 + time.month * 100 + time.day;
}

function dollars(value: number): string {
  return formatPrice(Math.round(value * 100));
}

/** A hex colour at an opacity, for canvas drawing that can't take `var(...)`. */
function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  const n = parseInt(match[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
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

/** What the two marks are: the day's hourly range, and the price it settles on. */
function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <svg aria-hidden="true" height="12" width="11">
          <line stroke="var(--up)" x1="2.5" x2="2.5" y1="0" y2="12" />
          {CANDLE_STYLE === 'hollow' ? (
            <rect fill="none" height="5" stroke="var(--up)" width="2" x="1.5" y="3.5" />
          ) : (
            <rect
              fill="var(--up)"
              fillOpacity={CANDLE_STYLE === 'light' ? 0.45 : 1}
              height="6"
              width="3"
              x="1"
              y="3"
            />
          )}
          <line stroke="var(--down)" x1="8.5" x2="8.5" y1="1" y2="11" />
          <rect fill="var(--down)" height="5" width="3" x="7" y="4" />
        </svg>
        Candle · 24 hourly prices: open, high, low, close
      </span>
      <span className="flex items-center gap-1.5">
        <svg aria-hidden="true" height="12" width="14">
          <line stroke="var(--chart-1)" strokeOpacity={0.8} x1="0" x2="14" y1="6" y2="6" />
        </svg>
        Line · daily average, the settlement price
      </span>
    </div>
  );
}

/** The caret used on a capped wick, for the caption line that explains it. */
function CaretGlyph() {
  return (
    <svg aria-hidden="true" className="shrink-0" height={CARET_HEIGHT + 2} width={CARET_WIDTH + 2}>
      <path
        d={`M1 ${CARET_HEIGHT + 1}L${CARET_WIDTH / 2 + 1} 1L${CARET_WIDTH + 1} ${CARET_HEIGHT + 1}Z`}
        fill="var(--foreground)"
      />
    </svg>
  );
}

/**
 * The default /trade chart: one candle per published day from its 24
 * hourly prices, with the verified daily average markets settle on drawn
 * over them, and every listed strike across both (design-brief.md §9).
 * Every published day is loaded; zoom and pan move through them, and the
 * presets only set the visible range. `onViewChange` reports the preset
 * the view matches after a double-click fit, or null once the viewer has
 * zoomed or panned away from one.
 */
export function SettlementPriceChart({
  request,
  onViewChange,
}: {
  request: PresetRequest;
  onViewChange: (range: RangePreset | null) => void;
}) {
  const records = useCommittedRecords('ERCOT_HBNORTH_DA_AVG');
  const priceCandles = usePriceCandles();
  const { markets, selected } = useMarkets();

  const lines = React.useMemo(
    () => strikeLines(markets ?? [], selected?.address),
    [markets, selected?.address],
  );

  // One entry per published day, in order: its candle, or null with none.
  const days = React.useMemo(() => {
    if (!records || !priceCandles) return null;
    const byDay = new Map(priceCandles.candles.map((candle) => [candle.dayKey, candle]));
    return records.map((record) => ({ record, candle: byDay.get(record.dayKey) ?? null }));
  }, [records, priceCandles]);

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const readoutRef = React.useRef<HTMLDivElement | null>(null);
  const chartRef = React.useRef<IChartApi | null>(null);
  const candleSeriesRef = React.useRef<ISeriesApi<'Custom', Time, CandlePoint | WhitespaceData<Time>> | null>(null);
  const averageSeriesRef = React.useRef<ISeriesApi<'Line', Time> | null>(null);
  const ladderRef = React.useRef<StrikeLadderPrimitive | null>(null);
  const daysRef = React.useRef<typeof days>(null);
  const strikesRef = React.useRef<number[]>([]);
  const scaleRef = React.useRef<ScaleState>({ cap: null, autoScale: () => true });
  // Set by a zoom or pan gesture, cleared when a preset is applied: a range
  // change while it is set means the viewer moved off the preset.
  const gestureRef = React.useRef(false);
  const onViewChangeRef = React.useRef(onViewChange);
  const skippedRef = React.useRef<{ dayKey: number; reason: string }[]>([]);
  React.useEffect(() => {
    onViewChangeRef.current = onViewChange;
    skippedRef.current = priceCandles?.skipped ?? [];
  }, [onViewChange, priceCandles]);

  const [stats, setStats] = React.useState<ViewStats>({ skipped: 0, spikes: 0, cap: null, manual: false });
  const [visibleSpan, setVisibleSpan] = React.useState('');
  const restoreAutoFitRef = React.useRef<(() => void) | null>(null);
  const refreshStatsRef = React.useRef<(() => void) | null>(null);

  /** The visible days' candles, and the price window they need. */
  const visibleWindow = React.useCallback((range: LogicalRange | null) => {
    const all = daysRef.current ?? [];
    const indices = visibleIndices(all.length, range);
    if (!indices) return null;
    const shown = all.slice(indices.first, indices.last + 1);
    const candles = shown.flatMap((day) =>
      day.candle ? [day.candle] : [{ high: day.record.value, low: day.record.value, average: day.record.value }],
    );
    return { shown, window: priceWindow(candles, strikesRef.current) };
  }, []);

  const renderReadout = React.useCallback((candle: PriceCandle | null, average: number | null, dayKey: number | null) => {
    const el = readoutRef.current;
    if (!el) return;
    if (dayKey === null) {
      el.textContent = '';
      return;
    }
    const parts = [dayLabel(dayKey, true)];
    if (candle) {
      parts.push(
        `O ${formatPrice(candle.open)}  H ${formatPrice(candle.high)}  L ${formatPrice(candle.low)}  C ${formatPrice(candle.close)}`,
      );
    }
    if (average !== null) parts.push(`Avg ${formatPrice(average)}`);
    el.textContent = parts.join('  ·  ');
  }, []);

  const renderLatest = React.useCallback(() => {
    const all = daysRef.current;
    const latest = all?.[all.length - 1];
    renderReadout(latest?.candle ?? null, latest?.record.value ?? null, latest?.record.dayKey ?? null);
  }, [renderReadout]);

  // The chart itself: created once, torn down on unmount.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const styles = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    const background = token('--background', '#0a0b0d');
    const border = token('--border', '#262a33');
    const muted = token('--muted-foreground', '#9aa1ac');
    const up = token('--up', '#1fce7a');
    const down = token('--down', '#ef4444');
    const warning = token('--warning', '#e8a33d');
    const chart1 = token('--chart-1', '#5b8def');
    const mono = token('--font-geist-mono', 'ui-monospace, monospace');

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: muted,
        fontFamily: mono,
        fontSize: 10,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: withAlpha(border, 0.45) },
      },
      rightPriceScale: {
        borderVisible: false,
        tickMarkDensity: 4,
        minimumWidth: 56,
        scaleMargins: { top: 0.02, bottom: 0.04 },
      },
      timeScale: {
        borderVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        rightOffset: 0,
        minBarSpacing: 0.5,
        tickMarkFormatter: (time: Time, type: TickMarkType) => {
          const label = dayLabel(dayKeyOf(time), true).split(' ');
          if (type === TickMarkType.Year) return label[2];
          if (type === TickMarkType.Month) return label[1];
          return label[0];
        },
      },
      crosshair: {
        vertLine: { color: withAlpha(muted, 0.5), labelBackgroundColor: border },
        horzLine: { color: withAlpha(muted, 0.5), labelBackgroundColor: border },
      },
      localization: {
        locale: 'en-GB',
        priceFormatter: (price: number) => dollars(price),
        tickmarksPriceFormatter: (prices: number[]) =>
          prices.map((price) => (price < 0 ? `-$${Math.abs(Math.round(price))}` : `$${Math.round(price)}`)),
        timeFormatter: (time: Time) => dayLabel(dayKeyOf(time), true),
      },
      // Wheel and pinch zoom the time axis; drag and horizontal wheel pan it.
      // A vertical swipe on a touch screen scrolls the page, never the chart.
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      // Dragging the price axis stretches the scale and switches auto-fit
      // off; a double-click on the axis (or the chart, or any preset)
      // switches it back on. On a touch screen a vertical drag on the axis
      // scrolls the page like the chart body does.
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: false, price: true },
      },
    });

    const scale = scaleRef.current;
    const priceScale = chart.priceScale('right');
    scale.autoScale = () => priceScale.options().autoScale;
    const restoreAutoFit = () => priceScale.applyOptions({ autoScale: true });
    restoreAutoFitRef.current = restoreAutoFit;
    const candles = chart.addCustomSeries(
      new CandleSeriesView(
        CANDLE_STYLE,
        { up, upLight: withAlpha(up, 0.45), down, flat: muted, background },
        scale,
      ),
      {
        priceLineVisible: false,
        lastValueVisible: false,
        // The scale refits to the visible days, capped so one spike can't
        // press the strikes into the bottom; the renderer marks what the cap cuts.
        autoscaleInfoProvider: () => {
          const found = visibleWindow(chart.timeScale().getVisibleLogicalRange());
          const window = found?.window;
          scale.cap = window?.cap ?? null;
          if (!window) return null;
          return {
            priceRange: { minValue: window.min, maxValue: window.max },
            margins: { above: TOP_MARGIN, below: 8 },
          };
        },
      },
    );
    const average = chart.addSeries(LineSeries, {
      color: withAlpha(chart1, 0.8),
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerRadius: 2.5,
      crosshairMarkerBorderColor: background,
      autoscaleInfoProvider: () => null,
    });
    const ladder = new StrikeLadderPrimitive({ warning, muted, background, font: mono });
    candles.attachPrimitive(ladder);

    chartRef.current = chart;
    candleSeriesRef.current = candles;
    averageSeriesRef.current = average;
    ladderRef.current = ladder;

    // What the caption reports for the days on screen, from the scale as it
    // stands: the cap while it fits itself, or the wicks cut at the top of a
    // hand-stretched scale.
    let frame = 0;
    const refreshStats = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const found = visibleWindow(chart.timeScale().getVisibleLogicalRange());
        if (!found || found.shown.length === 0) return;
        const first = found.shown[0].record.dayKey;
        const last = found.shown[found.shown.length - 1].record.dayKey;
        const manual = !priceScale.options().autoScale;
        const cutAtTop = found.shown.filter(({ candle }) => {
          const y = candle ? candles.priceToCoordinate(candle.high / 100) : null;
          return y !== null && y < MANUAL_CLIP;
        }).length;
        setVisibleSpan(`${first}-${last}`);
        setStats((previous) => {
          const next = {
            skipped: skippedInRange(skippedRef.current, first, last),
            spikes: manual ? cutAtTop : (found.window?.spikes ?? 0),
            cap: manual ? null : (found.window?.cap ?? null),
            manual,
          };
          return previous.skipped === next.skipped &&
            previous.spikes === next.spikes &&
            previous.cap === next.cap &&
            previous.manual === next.manual
            ? previous
            : next;
        });
      });
    };
    refreshStatsRef.current = refreshStats;
    const onRange = () => {
      if (gestureRef.current) onViewChangeRef.current(null);
      refreshStats();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);

    const onCrosshair = (param: MouseEventParams<Time>) => {
      if (param.time === undefined) {
        renderLatest();
        return;
      }
      const dayKey = dayKeyOf(param.time);
      const day = daysRef.current?.find((entry) => entry.record.dayKey === dayKey);
      renderReadout(day?.candle ?? null, day?.record.value ?? null, dayKey);
    };
    chart.subscribeCrosshairMove(onCrosshair);

    const onGesture = () => {
      gestureRef.current = true;
    };
    // A double-click on the price axis only switches auto-fit back on (the
    // library resets the axis itself); anywhere else it also fits every
    // published day, the same view as Full year.
    const onDoubleClick = (event: MouseEvent) => {
      const onPriceAxis = event.clientX - container.getBoundingClientRect().left > chart.paneSize().width;
      if (!onPriceAxis) {
        gestureRef.current = false;
        chart.timeScale().fitContent();
        onViewChangeRef.current('year');
      }
      restoreAutoFit();
      refreshStats();
    };
    // A stretch of the price axis changes what is cut at the top, which no
    // time-range event reports.
    const onRelease = () => refreshStats();
    container.addEventListener('wheel', onGesture, { passive: true });
    container.addEventListener('pointerdown', onGesture);
    container.addEventListener('pointerup', onRelease);
    container.addEventListener('dblclick', onDoubleClick);

    return () => {
      cancelAnimationFrame(frame);
      container.removeEventListener('wheel', onGesture);
      container.removeEventListener('pointerdown', onGesture);
      container.removeEventListener('pointerup', onRelease);
      container.removeEventListener('dblclick', onDoubleClick);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      chart.unsubscribeCrosshairMove(onCrosshair);
      restoreAutoFitRef.current = null;
      refreshStatsRef.current = null;
      chartRef.current = null;
      candleSeriesRef.current = null;
      averageSeriesRef.current = null;
      ladderRef.current = null;
      chart.remove();
    };
  }, [visibleWindow, renderReadout, renderLatest]);

  // Every published day, loaded once: the presets never filter them.
  React.useEffect(() => {
    daysRef.current = days;
    const candles = candleSeriesRef.current;
    const average = averageSeriesRef.current;
    if (!days || !candles || !average) return;
    candles.setData(
      days.map(({ record, candle }): CandlePoint | WhitespaceData<Time> =>
        candle
          ? {
              time: chartTime(record.dayKey),
              dayKey: record.dayKey,
              open: candle.open / 100,
              high: candle.high / 100,
              low: candle.low / 100,
              close: candle.close / 100,
              average: record.value / 100,
            }
          : { time: chartTime(record.dayKey) },
      ),
    );
    average.setData(days.map(({ record }) => ({ time: chartTime(record.dayKey), value: record.value / 100 })));
    renderLatest();
  }, [days, renderLatest]);

  // The strike ladder, and the strikes the scale always takes in.
  React.useEffect(() => {
    strikesRef.current = lines.map((line) => line.threshold / 100);
    ladderRef.current?.setLines(
      lines.map((line) => ({
        price: line.threshold / 100,
        tag: formatPrice(line.threshold),
        days: line.dayKeys.map((dayKey) => dayLabel(dayKey)).join(', '),
        selected: line.selected,
      })),
    );
  }, [lines]);

  // A preset sets the visible range, on every click and once the data is in.
  React.useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !days || days.length === 0) return;
    gestureRef.current = false;
    restoreAutoFitRef.current?.();
    chart.timeScale().setVisibleLogicalRange(presetRange(days.length, request.range));
    refreshStatsRef.current?.();
  }, [request, days]);

  let status: string | null = null;
  if (!days) status = 'Loading…';
  else if (days.length === 0) status = 'No prices published yet.';

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-[360px] flex-1 flex-col lg:flex-row">
        <PastFrequencyPanel marketsLoading={markets === null} records={records} selected={selected} />
        <div className="flex min-h-[300px] min-w-0 flex-1 flex-col pt-2">
          <div className="space-y-1 px-3 pb-1">
            <Legend />
            <div className="min-h-[1rem] font-mono text-[11px] tabular-nums text-foreground" ref={readoutRef} />
          </div>
          <div className="relative min-h-[300px] flex-1" data-visible-days={visibleSpan}>
            <div className="absolute inset-0" ref={containerRef} />
            {status && <p className="absolute top-0 left-0 p-3 text-xs text-muted-foreground">{status}</p>}
          </div>
        </div>
      </div>
      <div className="border-t border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        Daily Texas power price, $/MWh · the verified price markets settle on
        {stats.skipped > 0 && ` · ${stats.skipped} ${stats.skipped === 1 ? 'day' : 'days'} without 24 hours not drawn`}
        {stats.manual && (
          <div className="mt-0.5 flex items-center gap-1.5">
            <CaretGlyph />
            Scale set by hand · {stats.spikes} {stats.spikes === 1 ? 'spike' : 'spikes'} above it marked · double-click
            the price axis to refit
          </div>
        )}
        {!stats.manual && stats.cap !== null && (
          <div className="mt-0.5 flex items-center gap-1.5">
            <CaretGlyph />
            Scale capped at ${stats.cap.toLocaleString('en-US')} so the strikes stay readable · {stats.spikes} higher{' '}
            {stats.spikes === 1 ? 'spike' : 'spikes'} marked, real high on hover
          </div>
        )}
      </div>
    </div>
  );
}

export { RANGES as SETTLEMENT_RANGES, type RangePreset as SettlementRange };
