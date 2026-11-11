'use client';

import { useEffect, useRef, useState } from 'react';

import { normalPdf } from '@/lib/option-pricing';

const NP = 181;
const GAIN = '#35d39a';
const LOSS = '#ff6470';
const PAPER = '#f3f2ee';
const MIST = '#93918b';
const usd = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;

export interface PayoffInput {
  /** Expected day average and its typical miss, $/MWh. */
  forward: number;
  sigma: number;
  strike: number;
  isCall: boolean;
  /** Price paid per MWh, dollars. */
  premium: number;
  sizeMwh: number;
  band: { floor: number; cap: number };
}

/**
 * What an option pays at every settlement price, green above zero and red
 * below, with how likely each price is drawn underneath, the strike, the
 * expected price and the break-even. Point at it to read any price.
 */
export function PayoffChart(props: PayoffInput & { title: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const cur = useRef<Float64Array | null>(null);
  const hover = useRef<number | null>(null);
  const [read, setRead] = useState<{ text: string; tone?: 'g' | 'l' }>({ text: '' });
  const input = useRef(props);
  input.current = props;
  const shownRead = useRef('');

  const { forward, sigma, strike, isCall, premium, sizeMwh, band } = props;
  const lo = Math.max(band.floor, Math.min(forward - 3.6 * sigma, strike - 15));
  const hi = Math.min(band.cap, Math.max(forward + 3.6 * sigma, strike + 15));

  useEffect(() => {
    const target = new Float64Array(NP);
    const pay = (S: number) => {
      const s = Math.min(Math.max(S, band.floor), band.cap);
      return sizeMwh * ((isCall ? Math.max(s - strike, 0) : Math.max(strike - s, 0)) - premium);
    };
    for (let i = 0; i < NP; i++) target[i] = pay(lo + ((hi - lo) * i) / (NP - 1));
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!cur.current || cur.current.length !== NP || reduced) cur.current = Float64Array.from(target);

    let raf = 0;
    let last = performance.now();
    // the readout changes only when its words do, so drawing never re-renders the page
    const say = (r: { text: string; tone?: 'g' | 'l' }) => {
      if (r.text === shownRead.current) return;
      shownRead.current = r.text;
      setRead(r);
    };
    const draw = () => {
      const cv = canvas.current;
      const c = cv?.getContext('2d');
      const now = cur.current;
      if (!cv || !c || !now) return;
      const r = cv.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = r.width;
      const H = r.height;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
      }
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, H);
      const L0 = W < 500 ? 52 : 70;
      const T0 = 16;
      const pw = W - L0 - 16;
      const ph = H - T0 - 30;
      const xs = (S: number) => L0 + ((S - lo) / (hi - lo)) * pw;
      let mn = 0;
      let mx = 0;
      for (let i = 0; i < NP; i++) {
        mn = Math.min(mn, now[i]);
        mx = Math.max(mx, now[i]);
      }
      const span = Math.max(1, mx - mn);
      mx += span * 0.1;
      mn -= span * 0.1;
      const ys = (v: number) => T0 + ((mx - v) / (mx - mn)) * ph;
      const y0 = ys(0);
      c.font = `12px ${getComputedStyle(document.body).fontFamily}`;
      c.textBaseline = 'middle';
      // price grid
      const step = hi - lo > 90 ? 20 : 10;
      c.strokeStyle = '#151515';
      c.lineWidth = 1;
      c.fillStyle = MIST;
      c.textAlign = 'center';
      for (let g = Math.ceil(lo / step) * step; g <= hi; g += step) {
        const gx = Math.round(xs(g)) + 0.5;
        c.beginPath();
        c.moveTo(gx, T0);
        c.lineTo(gx, T0 + ph);
        c.stroke();
        c.fillText(`$${g}`, gx, H - 12);
      }
      // how likely each price is
      const pk = normalPdf(0);
      const dh = ph * 0.32;
      c.beginPath();
      c.moveTo(xs(lo), T0 + ph);
      for (let j = 0; j <= 120; j++) {
        const S = lo + ((hi - lo) * j) / 120;
        c.lineTo(xs(S), T0 + ph - (normalPdf((S - forward) / sigma) / pk) * dh);
      }
      c.lineTo(xs(hi), T0 + ph);
      c.closePath();
      c.fillStyle = 'rgba(243,242,238,0.05)';
      c.fill();
      c.strokeStyle = 'rgba(243,242,238,0.16)';
      c.stroke();
      // the curve, green above zero and red below
      const curve = () => {
        c.beginPath();
        for (let i = 0; i < NP; i++) {
          const x = xs(lo + ((hi - lo) * i) / (NP - 1));
          const y = ys(now[i]);
          if (i) c.lineTo(x, y);
          else c.moveTo(x, y);
        }
      };
      const zones: [number, number, string, string][] = [
        [T0, y0 - T0, 'rgba(53,211,154,0.13)', GAIN],
        [y0, T0 + ph - y0, 'rgba(255,100,112,0.11)', LOSS],
      ];
      zones.forEach(([top, height, fill, stroke]) => {
        if (height <= 0) return;
        c.save();
        c.beginPath();
        c.rect(L0, top, pw, height);
        c.clip();
        curve();
        c.lineTo(xs(hi), y0);
        c.lineTo(xs(lo), y0);
        c.closePath();
        c.fillStyle = fill;
        c.fill();
        curve();
        c.strokeStyle = stroke;
        c.lineWidth = 2;
        c.lineJoin = 'round';
        c.stroke();
        c.restore();
      });
      // zero, strike, expected price
      c.strokeStyle = '#3a3936';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(L0, Math.round(y0) + 0.5);
      c.lineTo(L0 + pw, Math.round(y0) + 0.5);
      c.stroke();
      c.textAlign = 'right';
      c.fillStyle = MIST;
      c.fillText('$0', L0 - 10, y0);
      let top = -Infinity;
      let bot = Infinity;
      now.forEach((v) => {
        top = Math.max(top, v);
        bot = Math.min(bot, v);
      });
      if (ys(top) < y0 - 18) {
        c.fillStyle = GAIN;
        c.fillText(`+${money(top)}`, L0 - 10, ys(top));
      }
      if (bot < 0) {
        c.textAlign = 'left';
        c.fillStyle = LOSS;
        c.fillText(`Most you lose ${usd(-bot)}`, L0 + 8, Math.min(T0 + ph - 8, ys(bot) + 13));
      }
      const p = input.current;
      const kx = Math.round(xs(p.strike)) + 0.5;
      c.setLineDash([3, 4]);
      c.strokeStyle = 'rgba(243,242,238,0.45)';
      c.beginPath();
      c.moveTo(kx, T0);
      c.lineTo(kx, T0 + ph);
      c.stroke();
      c.setLineDash([]);
      c.textAlign = 'left';
      c.fillStyle = PAPER;
      c.fillText(`Strike $${p.strike}`, kx + 6, T0 + 8);
      const fx = xs(p.forward);
      c.fillStyle = MIST;
      c.beginPath();
      c.arc(fx, T0 + ph - dh - 8, 2.5, 0, Math.PI * 2);
      c.fill();
      const right = fx > L0 + pw - 90;
      c.textAlign = right ? 'right' : 'left';
      c.fillText(`Expected ${usd(p.forward)}`, fx + (right ? -8 : 8), T0 + ph - dh - 8);
      const be = p.isCall ? p.strike + p.premium : p.strike - p.premium;
      if (be > lo && be < hi) {
        c.fillStyle = '#000';
        c.strokeStyle = PAPER;
        c.lineWidth = 1.5;
        c.beginPath();
        c.arc(xs(be), y0, 4, 0, Math.PI * 2);
        c.fill();
        c.stroke();
      }
      const hx = hover.current;
      if (hx != null && hx >= L0 && hx <= L0 + pw) {
        const S = lo + ((hx - L0) / pw) * (hi - lo);
        const v = pay(S);
        c.strokeStyle = 'rgba(243,242,238,0.35)';
        c.beginPath();
        c.moveTo(Math.round(hx) + 0.5, T0);
        c.lineTo(Math.round(hx) + 0.5, T0 + ph);
        c.stroke();
        c.fillStyle = v >= 0 ? GAIN : LOSS;
        c.beginPath();
        c.arc(hx, ys(v), 4, 0, Math.PI * 2);
        c.fill();
        say({ text: `If it averages ${usd(S)}: ${v >= 0 ? '+' : ''}${usd(v)}`, tone: v >= 0 ? 'g' : 'l' });
      } else {
        say({ text: `Breaks even at ${usd(be)}. Point at the chart to read it.` });
      }
    };
    const step = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const now = cur.current!;
      const k = 1 - Math.exp(-dt * 11);
      let done = true;
      for (let i = 0; i < NP; i++) {
        const d = target[i] - now[i];
        if (Math.abs(d) > 0.01) {
          now[i] += d * k;
          done = false;
        } else now[i] = target[i];
      }
      draw();
      if (!done) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    const cv = canvas.current;
    const onMove = (e: PointerEvent) => {
      hover.current = e.clientX - cv!.getBoundingClientRect().left;
      draw();
    };
    const onLeave = () => {
      hover.current = null;
      draw();
    };
    cv?.addEventListener('pointermove', onMove);
    cv?.addEventListener('pointerleave', onLeave);
    window.addEventListener('resize', draw);
    return () => {
      cancelAnimationFrame(raf);
      cv?.removeEventListener('pointermove', onMove);
      cv?.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('resize', draw);
    };
    // band is read through its two numbers, so a new object with the same values does not restart the chart
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forward, sigma, strike, isCall, premium, sizeMwh, band.floor, band.cap, lo, hi]);

  return (
    <section aria-label="What your option pays" className="cbox pay">
      <div className="phd">
        <span>{props.title}</span>
        <span aria-live="polite" className="read">
          {read.tone ? (
            <>
              {read.text.split(': ')[0]}: <span className={read.tone}>{read.text.split(': ')[1]}</span>
            </>
          ) : (
            read.text
          )}
        </span>
      </div>
      <div className="paywrap">
        <canvas aria-label="Profit or loss of the selected option at each settlement price" className="o-pay" ref={canvas} role="img" />
      </div>
      <div className="pkey">
        <span>
          <i className="k-g" />
          Profit
        </span>
        <span>
          <i className="k-l" />
          Loss
        </span>
        <span>
          <i className="k-d" />
          How likely each price is
        </span>
      </div>
    </section>
  );
}
