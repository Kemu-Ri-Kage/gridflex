'use client';

import * as React from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from 'lightweight-charts';

type Hub = 'HB_NORTH' | 'HB_WEST';
type Timeframe = '15m' | '1h' | '4h' | '1d' | '1w';

const HUBS: { id: Hub; label: string }[] = [
  { id: 'HB_NORTH', label: 'North Hub' },
  { id: 'HB_WEST', label: 'West Hub' },
];

const TIMEFRAMES: Timeframe[] = ['15m', '1h', '4h', '1d', '1w'];

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
  const seriesRef = React.useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [hub, setHub] = React.useState<Hub>('HB_NORTH');
  const [timeframe, setTimeframe] = React.useState<Timeframe>('1d');
  const [source, setSource] = React.useState<SourceMeta | null>(null);
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
      timeScale: { borderColor: border, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: muted }, horzLine: { color: muted } },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      borderVisible: false,
      wickUpColor: up,
      wickDownColor: down,
    });

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

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [renderLegend]);

  // Data load is keyed on hub/timeframe only - the strike price line lives
  // on the series itself and must not be touched by a candle refresh, or it
  // duplicates on every hub/timeframe switch (see the price-line effect
  // below).
  React.useEffect(() => {
    let cancelled = false;
    void loadCandles(hub).then((file) => {
      if (cancelled) return;
      setSource(file.sources[timeframe]);
      const series = seriesRef.current;
      if (!series) return;
      const data = file.candles[timeframe].map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      series.setData(data);
      chartRef.current?.timeScale().fitContent();

      const latest = data.length ? data[data.length - 1] : null;
      latestCandleRef.current = latest;
      renderLegend(latest);
    });
    return () => {
      cancelled = true;
    };
  }, [hub, timeframe, renderLegend]);

  // Owns the strike price line's full lifecycle: created once per
  // strikeDollars value, removed by this effect's own cleanup before the
  // next run (or on unmount) - never left dangling for a later effect run
  // to pile another line on top of.
  React.useEffect(() => {
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
      series.removePriceLine(line);
    };
  }, [strikeDollars]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="flex gap-1">
          {HUBS.map((h) => (
            <button
              className={
                'border px-2.5 py-1 font-mono text-xs uppercase tracking-[0.08em] ' +
                (hub === h.id
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground')
              }
              key={h.id}
              onClick={() => setHub(h.id)}
              type="button"
            >
              {h.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {TIMEFRAMES.map((tf) => (
            <button
              className={
                'border px-2.5 py-1 font-mono text-xs ' +
                (timeframe === tf
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground')
              }
              key={tf}
              onClick={() => setTimeframe(tf)}
              type="button"
            >
              {tf}
            </button>
          ))}
        </div>
      </div>
      <div className="relative min-h-[360px] flex-1">
        <div className="absolute inset-0" ref={containerRef} />
        <div
          className="pointer-events-none absolute top-2 left-2 z-10 font-mono text-xs tabular-nums text-muted-foreground"
          ref={legendRef}
        />
      </div>
      <div className="border-t border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        {hub} · {source ? source.dataset : 'loading…'}
        {source ? ` · sha256 ${source.sourceHash.slice(0, 8)}…` : ''}
      </div>
    </div>
  );
}
