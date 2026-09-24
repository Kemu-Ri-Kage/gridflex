'use client';

import * as React from 'react';
import {
  ColorType,
  createChart,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from 'lightweight-charts';

import { CaretGlyph } from '@/components/settlement-price-chart';
import { Segmented } from '@/components/terminal-ui';
import { formatUpdated } from '@/lib/format';
import { DEFAULT_BARS, liveWindow, switchRange, type Timeframe } from '@/lib/live-chart-view';
import { visibleIndices } from '@/lib/price-candles';
import {
  CandleSeriesView,
  MANUAL_CLIP,
  TOP_MARGIN,
  type OhlcPoint,
  type ScaleState,
} from '@/lib/settlement-chart-drawing';

type Hub = 'HB_NORTH' | 'HB_WEST';

/**
 * The Texas power price's hub - the only one the public site shows
 * (design-brief.md §5: hubs are never shown, so there is no switcher).
 */
const HUB: Hub = 'HB_NORTH';

const TIMEFRAMES: { id: Timeframe; label: string }[] = [
  { id: '15m', label: '15m' },
  { id: '1h', label: '1H' },
  { id: '4h', label: '4H' },
  { id: '1d', label: '1D' },
  { id: '1w', label: '1W' },
];

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface SourceMeta {
  dataset: string;
  sourceHash: string;
}

interface CandleFile {
  location: Hub;
  /** When build_candles.py last built this file from freshly fetched data. */
  generatedAt?: string;
  candles: Record<Timeframe, Candle[]>;
  // 15m/1h are built from a 5-minute dispatch dataset, 4h/1d/1w from the
  // 15-minute settlement dataset - keyed per timeframe so the chart can
  // caption honestly which dataset actually produced the visible candles,
  // instead of naming one dataset for data that came from two.
  sources: Record<Timeframe, SourceMeta>;
}

const candleCache = new Map<Hub, Promise<CandleFile>>();

function loadCandles(hub: Hub): Promise<CandleFile> {
  let cached = candleCache.get(hub);
  if (!cached) {
    cached = fetch(`/data/candles/${hub}.json`).then((r) => r.json() as Promise<CandleFile>);
    candleCache.set(hub, cached);
  }
  return cached;
}

export function CandlestickChart({ strikeDollars }: { strikeDollars?: number }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const chartRef = React.useRef<IChartApi | null>(null);
  const seriesRef = React.useRef<ISeriesApi<'Custom', Time, OhlcPoint | WhitespaceData<Time>> | null>(null);
  const [timeframe, setTimeframe] = React.useState<Timeframe>('1d');
  const [source, setSource] = React.useState<SourceMeta | null>(null);
  const [updatedAt, setUpdatedAt] = React.useState<string | null>(null);
  // lightweight-charts draws on canvas, so it can't resolve a `var(...)`
  // string the way DOM CSS does - colours are read once from the computed
  // stylesheet here and reused for anything drawn later (e.g. the strike
  // price line, the OHLC legend), not passed through as raw custom-property
  // references.
  const colorsRef = React.useRef({ warning: '#e8a33d', up: '#1fce7a', down: '#ef4444' });
  // The OHLC legend is written directly to the DOM (not React state) so a
  // fast-firing crosshair-move never triggers a React re-render per pixel -
  // matches design-brief.md §13's "instant or under 150ms" terminal rule
  // more literally than a state update could. latestCandleRef backs the
  // "show the latest candle when the cursor leaves the chart" fallback.
  const legendRef = React.useRef<HTMLDivElement | null>(null);
  const latestCandleRef = React.useRef<Candle | null>(null);
  // The strike the price scale always takes in, so its line can't scroll
  // out of view at any zoom - read by the series' autoscale provider.
  const strikeRef = React.useRef<number | undefined>(strikeDollars);
  // The timeframe's candles, read by the autoscale provider to fit the
  // scale to the ones on screen.
  const candlesRef = React.useRef<Candle[]>([]);
  const scaleRef = React.useRef<ScaleState>({ cap: null, autoScale: () => true });
  // Set once the viewer zooms or pans, so a timeframe switch keeps the span
  // of time they were looking at instead of jumping back to the default.
  const adjustedRef = React.useRef(false);
  const refreshStatsRef = React.useRef<() => void>(() => {});
  const [stats, setStats] = React.useState({
    cap: null as number | null,
    spikes: 0,
    floor: null as number | null,
    dips: 0,
    manual: false,
  });

  const renderLegend = React.useCallback((candle: Candle | null) => {
    const el = legendRef.current;
    if (!el) return;
    if (!candle) {
      el.textContent = '';
      return;
    }
    const isUp = candle.close >= candle.open;
    el.style.color = isUp ? colorsRef.current.up : colorsRef.current.down;
    el.textContent =
      `O ${candle.open.toFixed(2)}  H ${candle.high.toFixed(2)}  ` +
      `L ${candle.low.toFixed(2)}  C ${candle.close.toFixed(2)}`;
  }, []);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const styles = getComputedStyle(document.documentElement);
    const foreground = styles.getPropertyValue('--foreground').trim() || '#e7e9ed';
    const muted = styles.getPropertyValue('--muted-foreground').trim() || '#9aa1ac';
    const border = styles.getPropertyValue('--border').trim() || '#262a33';
    const up = styles.getPropertyValue('--up').trim() || '#1fce7a';
    const down = styles.getPropertyValue('--down').trim() || '#ef4444';
    colorsRef.current.warning = styles.getPropertyValue('--warning').trim() || '#e8a33d';
    colorsRef.current.up = up;
    colorsRef.current.down = down;
    const monoFont =
      styles.getPropertyValue('--font-geist-mono').trim() || 'ui-monospace, monospace';

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: muted,
        fontFamily: monoFont,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: border, style: LineStyle.Dotted },
        horzLines: { color: border, style: LineStyle.Dotted },
      },
      rightPriceScale: { borderColor: border },
      // Fixed edges: the chart can't be dragged into empty space past the
      // first or last candle.
      timeScale: {
        borderColor: border,
        timeVisible: true,
        secondsVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        rightOffset: 0,
      },
      crosshair: { vertLine: { color: muted }, horzLine: { color: muted } },
      // The same gestures as the settlement chart: wheel and pinch zoom the
      // time axis, drag and horizontal swipe pan it, and a vertical swipe on
      // a touch screen scrolls the page instead of being swallowed. Dragging
      // the price axis stretches the scale and switches auto-fit off; a
      // double-click on the axis or the chart, or a timeframe switch,
      // switches it back on.
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: false, price: true },
      },
    });

    // The settlement view's candle renderer, filled: the same thin, spaced
    // bodies and 1px wicks in --up/--down on both views, and the same caret
    // on a wick the capped scale cuts.
    const background = styles.getPropertyValue('--background').trim() || '#0a0b0d';
    const scale = scaleRef.current;
    const priceScale = chart.priceScale('right');
    scale.autoScale = () => priceScale.options().autoScale;
    const visibleCandles = () => {
      const all = candlesRef.current;
      const indices = visibleIndices(all.length, chart.timeScale().getVisibleLogicalRange());
      return indices ? all.slice(indices.first, indices.last + 1) : [];
    };
    const series = chart.addCustomSeries(
      new CandleSeriesView<OhlcPoint>('filled', { up, upLight: up, down, flat: muted, background }, scale),
      {
        // The scale refits to the visible candles, capped so one spike can't
        // press every normal candle into the bottom; the renderer marks what
        // the cap cuts. The strike is always in range.
        autoscaleInfoProvider: () => {
          const window = liveWindow(visibleCandles(), strikeRef.current);
          scale.cap = window?.cap ?? null;
          if (!window) return null;
          return {
            priceRange: { minValue: window.min, maxValue: window.max },
            margins: { above: TOP_MARGIN, below: 8 },
          };
        },
      },
    );

    chartRef.current = chart;
    seriesRef.current = series;
    void foreground;

    // Crosshair-driven OHLC legend, per design-brief.md §9. `param.time` is
    // undefined once the pointer leaves the chart pane, in which case the
    // legend falls back to the latest loaded candle rather than going
    // blank. Tied to the chart's own lifetime (mount effect, deps=[]) since
    // the handler reads current series data live on every call - it never
    // needs to be recreated when hub/timeframe changes, only torn down
    // once, here, on unmount - the same leak this component already fixed
    // once for the strike price line.
    const onCrosshairMove = (param: MouseEventParams) => {
      const series = seriesRef.current;
      if (!series) return;
      if (param.time === undefined) {
        renderLegend(latestCandleRef.current);
        return;
      }
      const bar = param.seriesData.get(series) as
        | { open: number; high: number; low: number; close: number }
        | undefined;
      renderLegend(bar ? { time: param.time as unknown as number, ...bar } : latestCandleRef.current);
    };
    chart.subscribeCrosshairMove(onCrosshairMove);
    renderLegend(latestCandleRef.current);

    // A double-click on the price axis only switches auto-fit back on (the
    // library resets the axis itself); anywhere else it also refits every
    // candle of the timeframe, matching the settlement view.
    const onDoubleClick = (event: MouseEvent) => {
      const onPriceAxis = event.clientX - container.getBoundingClientRect().left > chart.paneSize().width;
      if (!onPriceAxis) chart.timeScale().fitContent();
      chart.priceScale('right').applyOptions({ autoScale: true });
      refreshStats();
    };
    container.addEventListener('dblclick', onDoubleClick);

    // What the caption reports for the candles on screen, from the scale as
    // it stands: the cap while it fits itself, or the wicks cut at the top
    // of a hand-stretched scale.
    let frame = 0;
    const refreshStats = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const shown = visibleCandles();
        const manual = !priceScale.options().autoScale;
        const window = liveWindow(shown, strikeRef.current);
        const cutAtTop = shown.filter((candle) => {
          const y = series.priceToCoordinate(candle.high);
          return y !== null && y < MANUAL_CLIP;
        }).length;
        const next = {
          cap: manual ? null : (window?.cap ?? null),
          spikes: manual ? cutAtTop : (window?.spikes ?? 0),
          floor: manual ? null : (window?.floor ?? null),
          dips: manual ? 0 : (window?.dips ?? 0),
          manual,
        };
        setStats((previous) =>
          (Object.keys(next) as (keyof typeof next)[]).every((key) => previous[key] === next[key]) ? previous : next,
        );
      });
    };
    refreshStatsRef.current = refreshStats;
    chart.timeScale().subscribeVisibleLogicalRangeChange(refreshStats);

    // Any zoom or pan by the viewer - wheel, drag, pinch - marks the view as
    // theirs to keep. A drag on the price axis may also have switched
    // auto-fit off, which the caption reports once the pointer lifts.
    const onGesture = () => {
      adjustedRef.current = true;
    };
    container.addEventListener('wheel', onGesture, { passive: true });
    container.addEventListener('pointerdown', onGesture);
    container.addEventListener('pointerup', refreshStats);

    return () => {
      cancelAnimationFrame(frame);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(refreshStats);
      container.removeEventListener('wheel', onGesture);
      container.removeEventListener('pointerdown', onGesture);
      container.removeEventListener('pointerup', refreshStats);
      container.removeEventListener('dblclick', onDoubleClick);
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      // Nulled before remove() so the strike-line cleanup below can tell the
      // series is gone and skip it.
      chartRef.current = null;
      seriesRef.current = null;
      chart.remove();
    };
  }, [renderLegend]);

  // Data load is keyed on timeframe only - the strike price line lives on
  // the series itself and must not be touched by a candle refresh, or it
  // duplicates on every timeframe switch (see the price-line effect below).
  React.useEffect(() => {
    let cancelled = false;
    void loadCandles(HUB).then((file) => {
      if (cancelled) return;
      setSource(file.sources[timeframe]);
      setUpdatedAt(formatUpdated(file.generatedAt));
      const series = seriesRef.current;
      const chart = chartRef.current;
      if (!series || !chart) return;
      // The span of time on screen, kept across the switch once the viewer
      // has zoomed or panned; read before the old candles are replaced.
      const visible = adjustedRef.current ? chart.timeScale().getVisibleRange() : null;
      const kept = visible ? { from: visible.from as number, to: visible.to as number } : null;
      const candles = file.candles[timeframe];
      candlesRef.current = candles;
      const data = candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        // Colours the last-price tag by the candle's direction.
        color: c.close >= c.open ? colorsRef.current.up : colorsRef.current.down,
      }));
      series.setData(data);
      // A timeframe switch opens on its recent candles (DEFAULT_BARS), or on
      // the viewer's own span of time, and always with the price axis
      // fitting itself again, even after it was stretched by hand.
      chart.priceScale('right').applyOptions({ autoScale: true });
      chart.timeScale().setVisibleLogicalRange(
        switchRange(
          candles.map((c) => c.time),
          DEFAULT_BARS[timeframe],
          kept,
        ),
      );
      refreshStatsRef.current();

      const latest = data.length ? data[data.length - 1] : null;
      latestCandleRef.current = latest;
      renderLegend(latest);
    });
    return () => {
      cancelled = true;
    };
  }, [timeframe, renderLegend]);

  // Owns the strike price line's full lifecycle: created once per
  // strikeDollars value, removed by this effect's own cleanup before the
  // next run - never left dangling for a later effect run to pile another
  // line on top of.
  //
  // React runs unmount cleanups in declaration order, and this effect has
  // to be declared after the mount effect so the series exists when it
  // runs. So on unmount (MarketChart re-keys this component per market) the
  // mount effect's chart.remove() has already disposed the series by the
  // time this cleanup runs, and removePriceLine() would throw "Object is
  // disposed". The mount cleanup nulls seriesRef before disposing, so a
  // series that is no longer current is left alone - the line went with
  // the chart.
  React.useEffect(() => {
    strikeRef.current = strikeDollars;
    const series = seriesRef.current;
    if (!series || strikeDollars === undefined) return;

    const line = series.createPriceLine({
      price: strikeDollars,
      color: colorsRef.current.warning,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `strike $${strikeDollars}`,
    });

    return () => {
      if (seriesRef.current === series) series.removePriceLine(line);
    };
  }, [strikeDollars]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="text-xs text-muted-foreground">Texas power · $/MWh</div>
        <Segmented label="Timeframe" onChange={setTimeframe} options={TIMEFRAMES} value={timeframe} />
      </div>
      <div className="relative min-h-[360px] flex-1">
        <div className="absolute inset-0" ref={containerRef} />
        <div
          className="pointer-events-none absolute top-2 left-2 z-10 font-mono text-xs tabular-nums text-muted-foreground"
          ref={legendRef}
        />
      </div>
      {/* Live market data, not an oracle reading: the caption says what
          the markets actually settle on, so it never reads as the same
          trust level as a Verified price (§6). The dataset and its hash
          stay in the candle file; the hub code and dataset name are never
          shown (§5). */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-t border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        <span title={source ? `sha256 ${source.sourceHash}` : undefined}>
          Live prices, for reference · markets settle on the verified daily Texas power price
        </span>
        {updatedAt && <span className="tabular-nums">Updated {updatedAt}</span>}
        {stats.manual && stats.spikes > 0 && (
          <div className="flex w-full items-center gap-1.5">
            <CaretGlyph />
            Scale set by hand · {stats.spikes} {stats.spikes === 1 ? 'spike' : 'spikes'} above it marked · double-click
            the price axis to refit
          </div>
        )}
        {!stats.manual && stats.cap !== null && (
          <div className="flex w-full items-center gap-1.5">
            <CaretGlyph />
            Scale capped at ${stats.cap.toLocaleString('en-US')} so typical prices stay readable · {stats.spikes} higher{' '}
            {stats.spikes === 1 ? 'spike' : 'spikes'} marked, real high on hover
          </div>
        )}
        {!stats.manual && stats.floor !== null && (
          <div className="w-full">
            Scale floored at -${Math.abs(stats.floor).toLocaleString('en-US')} · {stats.dips} deeper negative{' '}
            {stats.dips === 1 ? 'price runs' : 'prices run'} below it, real low on hover
          </div>
        )}
      </div>
    </div>
  );
}
