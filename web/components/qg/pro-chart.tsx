'use client';

import { useEffect, useRef, useState } from 'react';

import { useLivePrice } from '@/components/qg/use-live-price';
import { usePriceGrid } from '@/lib/site-data';

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
type CandleFile = { candles: Record<string, Candle[]> };

export interface ChartPosition {
  price: number;
  long: boolean;
  title: string;
}

interface ChartControls {
  setPositions: (list: ChartPosition[]) => void;
  setSize: (n: number) => void;
  setLive: (price: number, startUtc: number) => void;
  destroy: () => void;
}

let candleFile: Promise<CandleFile> | null = null;
function loadCandles(): Promise<CandleFile> {
  candleFile ??= fetch('/data/candles/HB_NORTH.json').then((r) => r.json() as Promise<CandleFile>);
  return candleFile;
}

/**
 * The latest 15-minute candle's close and the close 24 hours before it, from
 * the published candle file: the price the page shows when the live
 * 5-minute price is not available.
 */
export function useLastCandle(): { close: number; time: number; dayAgo: number | null } | null {
  const [last, setLast] = useState<{ close: number; time: number; dayAgo: number | null } | null>(null);
  useEffect(() => {
    let alive = true;
    void loadCandles()
      .then((file) => {
        const c = file.candles['15m'] ?? [];
        if (!alive || c.length === 0) return;
        const end = c[c.length - 1];
        const before = c.findLast((x) => x.time <= end.time - 86_400);
        setLast({ close: end.close, time: end.time, dayAgo: before ? before.close : null });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return last;
}

const TF_BUTTONS = [
  { tf: 900, label: '15m' },
  { tf: 3600, label: '1H' },
  { tf: 14400, label: '4H' },
  { tf: 86400, label: '1D' },
  { tf: 604800, label: '1W' },
];

/**
 * The futures chart box: candles from /data/candles (ERCOT North Hub, real
 * time), the day-ahead grid, the live 5-minute price, and the trader's
 * positions as entry lines. The drawing and charting engine is
 * components/qg/chart-engine.js; this component renders its markup and feeds it.
 */
export function ProChart({ positions, size }: { positions?: ChartPosition[]; size?: number }) {
  const ref = useRef<HTMLElement>(null);
  const engine = useRef<ChartControls | null>(null);
  const grid = usePriceGrid();
  const { live } = useLivePrice();
  const [failed, setFailed] = useState(false);
  const latest = useRef({ positions, size, live });
  latest.current = { positions, size, live };

  useEffect(() => {
    const root = ref.current;
    if (!root || !grid) return;
    let cancelled = false;
    void Promise.all([loadCandles(), import('@/components/qg/chart-engine.js')])
      .then(([file, mod]) => {
        if (cancelled) return;
        const controls = mod.mountChart(root, { candles: file.candles, days: grid.days }) as ChartControls;
        engine.current = controls;
        const now = latest.current;
        if (now.positions) controls.setPositions(now.positions);
        if (now.size) controls.setSize(now.size);
        if (now.live) controls.setLive(now.live.price, Date.parse(now.live.intervalStartUtc) / 1000);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      engine.current?.destroy();
      engine.current = null;
    };
  }, [grid]);

  useEffect(() => {
    engine.current?.setPositions(positions ?? []);
  }, [positions]);
  useEffect(() => {
    if (size) engine.current?.setSize(size);
  }, [size]);
  useEffect(() => {
    if (live) engine.current?.setLive(live.price, Date.parse(live.intervalStartUtc) / 1000);
  }, [live]);

  return (
    <section aria-label="Price chart" className="cbox" data-lenis-prevent id="cbox" ref={ref}>
      <div className="ctop">
        <div aria-label="Timeframe" className="grp" id="tfs" role="group">
          {TF_BUTTONS.map((b) => (
            <button aria-pressed={b.tf === 3600} className="tb" data-tf={b.tf} key={b.tf} type="button">
              {b.label}
            </button>
          ))}
        </div>
        <span aria-hidden className="sep" />
        <div aria-label="Chart type" className="grp" id="types" role="group">
          <button aria-pressed="true" className="tb" data-ty="candles" title="Candles" type="button">
            <svg aria-hidden fill="none" height="18" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 18 18" width="18">
              <line x1="5" x2="5" y1="2" y2="16" />
              <rect fill="currentColor" height="7" width="4" x="3" y="5" />
              <line x1="13" x2="13" y1="3" y2="15" />
              <rect height="5" width="4" x="11" y="6" />
            </svg>
            <span>Candles</span>
          </button>
          <button aria-pressed="false" className="tb" data-ty="bars" title="Bars" type="button">
            <svg aria-hidden fill="none" height="18" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 18 18" width="18">
              <line x1="5" x2="5" y1="3" y2="15" />
              <line x1="2.5" x2="5" y1="6" y2="6" />
              <line x1="5" x2="7.5" y1="12" y2="12" />
              <line x1="13" x2="13" y1="2" y2="14" />
              <line x1="10.5" x2="13" y1="10" y2="10" />
              <line x1="13" x2="15.5" y1="5" y2="5" />
            </svg>
            <span>Bars</span>
          </button>
          <button aria-pressed="false" className="tb" data-ty="line" title="Line" type="button">
            <svg aria-hidden fill="none" height="18" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 18 18" width="18">
              <polyline points="2,13 6,8 10,11 16,4" />
            </svg>
            <span>Line</span>
          </button>
          <button aria-pressed="false" className="tb" data-ty="area" title="Area" type="button">
            <svg aria-hidden fill="none" height="18" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 18 18" width="18">
              <polyline points="2,13 6,8 10,11 16,4" />
              <path d="M2 13 L6 8 L10 11 L16 4 L16 16 L2 16 Z" fill="currentColor" fillOpacity=".25" stroke="none" />
            </svg>
            <span>Area</span>
          </button>
          <button aria-pressed="false" className="tb" data-ty="3d" title="3D" type="button">
            <span>3D</span>
          </button>
        </div>
        <span aria-hidden className="sep" />
        <div aria-label="Indicators" className="grp" role="group">
          <button className="tb ind" data-ind="ma20" type="button">
            <span className="sw" style={{ background: 'var(--volt)' }} />
            MA 20
          </button>
          <button className="tb ind" data-ind="ma50" type="button">
            <span className="sw" style={{ background: '#7aa7ff' }} />
            MA 50
          </button>
          <button className="tb ind" data-ind="bb" type="button">
            <span className="sw" style={{ background: '#9a9893' }} />
            Bollinger
          </button>
          <button className="tb ind" data-ind="rsi" type="button">
            <span className="sw" style={{ background: '#d9c7a3' }} />
            RSI
          </button>
          <button className="tb ind" data-ind="da" type="button">
            <span className="sw" style={{ background: 'var(--paper)' }} />
            Day-ahead
          </button>
        </div>
        <span className="grow" />
        <button className="tb" id="fit" title="Reset the view" type="button">
          <svg aria-hidden fill="none" height="18" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 18 18" width="18">
            <polyline points="2,6 2,2 6,2" />
            <polyline points="12,2 16,2 16,6" />
            <polyline points="16,12 16,16 12,16" />
            <polyline points="6,16 2,16 2,12" />
          </svg>
          <span>Fit</span>
        </button>
        <button aria-label="Full screen" className="tb" id="full" title="Full screen" type="button">
          <svg aria-hidden fill="none" height="18" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 18 18" width="18">
            <path d="M2 7V2h5M11 2h5v5M16 11v5h-5M7 16H2v-5" />
          </svg>
        </button>
      </div>
      <div className="cbody">
        <div aria-label="Drawing tools" className="tools" id="tools" role="toolbar" />
        <div className="cwrap" id="cwrap">
          <div id="lw" />
          <canvas aria-hidden id="draw" />
          <div aria-live="off" className="legend" id="legend">
            {failed ? 'The chart could not load. Check your connection and reload.' : ''}
          </div>
          <div aria-label="Selected drawing" className="otb" hidden id="otb" role="toolbar" />
          <div aria-label="Price scale" className="scl" id="scl" role="group">
            <button aria-pressed="true" data-scale="auto" title="Fit prices to the view" type="button">
              Auto
            </button>
            <button aria-pressed="false" data-scale="log" title="Logarithmic scale" type="button">
              Log
            </button>
            <button aria-pressed="false" data-scale="pct" title="Percent scale" type="button">
              %
            </button>
          </div>
          <button aria-label="Go to the latest price" className="rtb" hidden id="rtb" title="Go to the latest price" type="button">
            <svg aria-hidden fill="none" height="14" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 14 14" width="14">
              <path d="M3 3l4 4-4 4M8 3l4 4-4 4" />
            </svg>
          </button>
          <canvas aria-label="Last seven days of hourly day-ahead prices in 3D. Drag to turn." hidden id="t3d" role="img" />
          <span className="chint" id="chint">
            Scroll to zoom, drag to pan. Shift + click to measure.
          </span>
        </div>
      </div>
      <div className="fly" hidden id="fly" role="menu" />
      <div aria-live="polite" className="toast" id="ctoast" role="status" />
    </section>
  );
}
