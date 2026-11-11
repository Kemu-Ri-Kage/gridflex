'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef } from 'react';

import { useLivePrice } from '@/components/qg/use-live-price';
import { useMarkets } from '@/lib/markets';
import { forwardAndSigma, quoteStrike } from '@/lib/option-pricing';
import type { PriceGrid } from '@/lib/price-grid';
import { useCommittedRecords, usePriceGrid } from '@/lib/site-data';

const usd = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const BAND = { floor: -50, cap: 300 };
const f1 = (n: number) => (Math.round(n * 10) / 10).toString();

function dayLong(dayKey: number): string {
  const d = new Date(Date.UTC(Math.floor(dayKey / 10_000), Math.floor((dayKey % 10_000) / 100) - 1, dayKey % 100));
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(d)
    .replace(',', '');
}

/** The home page: the 3D story, the four products, the last settled day. */
export function Home() {
  const grid = usePriceGrid();
  return (
    <>
      {grid ? <Story grid={grid} /> : <div className="story-wait" aria-hidden />}
      <FourWays grid={grid} />
      <Settled />
      <section aria-label="Start" className="endcta">
        <div className="wrap">
          <h2>Ready when the grid is.</h2>
          <Link className="pill solid big" href="/futures">
            Open the terminal
          </Link>
        </div>
      </section>
    </>
  );
}

function LiveLine() {
  const { live, stale } = useLivePrice();
  if (!live) return null;
  return (
    <div aria-live="polite" className="hero-live">
      <span aria-hidden className="pulse" />
      <span className="muted">{stale ? 'Texas power, last price' : 'Texas power now'}</span> <b>{usd(live.price)}</b>{' '}
      <span className="muted">per MWh</span>
    </div>
  );
}

function Story({ grid }: { grid: PriceGrid }) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    // three.js is loaded only here, after the page has painted
    void import('@/components/landing/story-engine.js').then(({ mountStory }) => {
      if (!cancelled) stop = mountStory(root, grid);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [grid]);

  const days = grid.days.length;
  return (
    <section aria-label="How Gridflex works" className="story" id="story" ref={ref}>
      <div className="stage">
        <canvas aria-hidden className="scene" />
        <span aria-hidden className="dhint" data-f="dhint">
          <svg fill="none" stroke="currentColor" strokeWidth="1.3" viewBox="0 0 16 16">
            <path d="M2.5 8a5.5 5.5 0 0 1 10.2-2.9M13.5 8a5.5 5.5 0 0 1-10.2 2.9" />
            <path d="M12.9 2.4v2.9H10M3.1 13.6v-2.9H6" />
          </svg>
          <span data-f="dhint-t">Drag to turn</span>
        </span>
        <div aria-hidden className="tags">
          <span className="tag" data-f="tag-peak">
            <span className="dot" />
            <span data-f="peak">Peak</span>
          </span>
          <span className="tag" data-f="tag-strike">
            Strike
          </span>
        </div>
        <div className="narr">
          <div className="wrap">
            <div className="chapter on" data-ch="0">
              <h1>Trade the price of Texas power.</h1>
              <p className="lede">
                Go long or short on the live price, buy calls and puts on a day&apos;s average, or lock in a price for the
                power you use. Every bar here is a real hourly price from the last {days} days.
              </p>
              <div className="acts">
                <Link className="pill solid big" href="/futures">
                  Open the terminal
                </Link>
                <button className="pill ghost big" data-go="1" type="button">
                  See how it works
                </button>
              </div>
              <LiveLine />
            </div>
            <div className="chapter" data-ch="1">
              <p className="kicker">Futures</p>
              <h2>Long or short on the live price.</h2>
              <p className="lede">
                This is the latest day, hour by hour. Go long if you think the price will rise, short if you think it will
                fall. Fully backed, so no leverage and no liquidation.
              </p>
              <div className="fact">
                <div>
                  <span>Day&apos;s low</span>
                  <b data-f="low">–</b>
                  <span data-f="low-h" />
                </div>
                <div>
                  <span>Day&apos;s high</span>
                  <b data-f="high">–</b>
                  <span data-f="high-h" />
                </div>
              </div>
              <div className="acts">
                <Link className="pill solid" href="/futures">
                  Open futures
                </Link>
              </div>
            </div>
            <div className="chapter" data-ch="2">
              <p className="kicker">Options</p>
              <h2>Pick a price. Calls pay above it, puts pay below.</h2>
              <div className="strike">
                <label htmlFor="strike">
                  Price level <b data-f="strike-v">$45</b>
                </label>
                <input data-f="strike" defaultValue="45" id="strike" max="80" min="20" step="1" type="range" />
                <p aria-live="polite" className="strike-out" data-f="strike-out" />
              </div>
              <div className="acts">
                <Link className="pill solid" href="/options">
                  Open options
                </Link>
              </div>
            </div>
            <div className="chapter" data-ch="3">
              <p className="kicker">Hedge</p>
              <h2>Lock the price of the power you use.</h2>
              <p className="lede">
                Lock $40 for 10 MW and your power costs $9,600 a day, whatever the grid does. The ups and downs flatten into
                one line.
              </p>
              <div className="acts">
                <Link className="pill solid" href="/hedge">
                  Plan a hedge
                </Link>
              </div>
            </div>
          </div>
        </div>
        <div className="chapnav">
          <div className="wrap">
            <fieldset aria-label="Story" className="chips">
              <button aria-current="step" data-go="0" type="button">
                Market
              </button>
              <button data-go="1" type="button">
                Futures
              </button>
              <button data-go="2" type="button">
                Options
              </button>
              <button data-go="3" type="button">
                Hedge
              </button>
            </fieldset>
            <div className="right">
              <button className="calm" data-f="reset-look" hidden type="button">
                Reset view
              </button>
              <button aria-pressed="false" className="calm" data-f="calm" type="button">
                Pause motion
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Adds .revealed (and a one-off .drawing) when an element scrolls into view. */
function useReveal<T extends HTMLElement>(drawing = false) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.classList.add('revealed');
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          el.classList.add('revealed');
          if (drawing) {
            el.classList.add('drawing');
            timer = setTimeout(() => el.classList.remove('drawing'), 2200);
          }
          io.disconnect();
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [drawing]);
  return ref;
}

function Way({
  href,
  delay,
  title,
  text,
  foot,
  children,
}: {
  href: string;
  delay: number;
  title: string;
  text: string;
  foot: string;
  children: React.ReactNode;
}) {
  const ref = useReveal<HTMLAnchorElement>(true);
  return (
    <Link className="way" data-reveal href={href} ref={ref} style={{ transitionDelay: `${delay}s` }}>
      <svg aria-hidden preserveAspectRatio="xMidYMid meet" viewBox="0 0 240 96">
        {children}
      </svg>
      <h3>{title}</h3>
      <p>{text}</p>
      <div className="wf">
        <span>{foot}</span>
        <span aria-hidden className="ar">
          <svg fill="none" height="14" stroke="currentColor" strokeWidth="1.6" style={{ width: 14, height: 14, margin: 0 }} viewBox="0 0 14 14" width="14">
            <path d="M2 7h10M8 3l4 4-4 4" />
          </svg>
        </span>
      </div>
    </Link>
  );
}

/**
 * Four ways in, drawn under one rule: a dashed line is the price level you
 * pick (entry, strike, locked price, the question's line) and the drawing
 * shows how the product answers it. Real prices throughout.
 */
function FourWays({ grid }: { grid: PriceGrid | null }) {
  const head = useReveal<HTMLHeadingElement>();
  const { live } = useLivePrice();
  const records = useCommittedRecords('ERCOT_HBNORTH_DA_AVG');
  const { markets, now } = useMarkets();
  const averages = useMemo(() => (grid ? grid.days.map((d) => d.average / 100) : []), [grid]);

  const fut = useMemo(() => {
    if (!grid) return null;
    // the last two days, hour by hour, against the middle price of the window
    const v = grid.days.slice(-2).flatMap((d) => d.hours.map((c) => c / 100));
    const mn = Math.min(...v);
    const sp = Math.max(1, Math.max(...v) - mn);
    const pts = v.map((x, i) => [4 + (i / (v.length - 1)) * 222, 82 - ((x - mn) / sp) * 68]);
    const entry = [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
    const yE = 82 - ((entry - mn) / sp) * 68;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${f1(p[0])} ${f1(p[1])}`).join('');
    return { d, area: `${d}L226 ${f1(yE)}L4 ${f1(yE)}Z`, yE, last: pts[pts.length - 1] };
  }, [grid]);

  const opt = useMemo(() => {
    let bell = 'M0 88';
    for (let x = 0; x <= 240; x += 6) bell += `L${x} ${f1(88 - Math.exp(-0.5 * ((x - 108) / 30) ** 2) * 30)}`;
    bell += 'L240 88Z';
    const K = 128;
    const yZ = 56;
    const yP = 66;
    const top = [234, 10];
    const be = K + (yP - yZ) / ((yP - top[1]) / (top[0] - K));
    return { bell, K, yZ, yP, top, be };
  }, []);

  const model = useMemo(() => {
    if (!records || records.length < 3) return null;
    const history = [...records].sort((a, b) => a.dayKey - b.dayKey).map((r) => r.value / 100);
    const fs = forwardAndSigma(history, null);
    if (!fs) return null;
    const k = Math.round(fs.forward / 5) * 5 + 5;
    return { k, ask: quoteStrike(fs.forward, k, fs.sigma, BAND).callAsk / 100, forward: fs.forward };
  }, [records]);

  const open = markets ? markets.filter((m) => m.metricId === 'ERCOT_HBNORTH_DA_AVG' && now < m.resolveAfter * 1000).length : null;

  return (
    <section aria-label="Ways to trade" className="ways">
      <div className="wrap">
        <h2 data-reveal ref={head}>
          Four ways to trade one price.
        </h2>
        <div className="wgrid">
          <Way
            delay={0}
            foot={live ? `${usd(live.price)} now` : 'Texas power, live'}
            href="/futures"
            text="Long or short on the live price, every 5 minutes. Fully backed, so nothing gets liquidated."
            title="Futures"
          >
            {fut && (
              <>
                <defs>
                  <clipPath id="wf-u">
                    <rect height={f1(fut.yE)} width="240" x="0" y="0" />
                  </clipPath>
                  <clipPath id="wf-d">
                    <rect height={f1(96 - fut.yE)} width="240" x="0" y={f1(fut.yE)} />
                  </clipPath>
                </defs>
                <path className="ga" clipPath="url(#wf-u)" d={fut.area} />
                <path className="la" clipPath="url(#wf-d)" d={fut.area} />
                <path className="lvl" d={`M0 ${f1(fut.yE)}H240`} />
                <path className="ln" d={fut.d} pathLength={400} />
                <circle className="ring" cx={f1(fut.last[0])} cy={f1(fut.last[1])} r="3.5" />
                <circle className="live" cx={f1(fut.last[0])} cy={f1(fut.last[1])} r="3.5" />
              </>
            )}
          </Way>
          <Way
            delay={0.08}
            foot={model ? `$${model.k} calls from ${usd(model.ask)}` : 'Calls and puts'}
            href="/options"
            text="Calls and puts on a day's average. The most you can lose is what you pay."
            title="Options"
          >
            <path className="bell" d={opt.bell} />
            <path className="zl" d={`M0 ${opt.yZ}H240`} />
            <path className="la" d={`M6 ${opt.yZ}H${f1(opt.be)}L${opt.K} ${opt.yP}H6Z`} />
            <path className="ga" d={`M${f1(opt.be)} ${opt.yZ}L${opt.top[0]} ${opt.top[1]}V${opt.yZ}Z`} />
            <path className="lvl" d={`M${opt.K} 4V92`} />
            <path className="ln" d={`M6 ${opt.yP}H${opt.K}L${opt.top[0]} ${opt.top[1]}`} pathLength={400} />
            <circle className="be" cx={f1(opt.be)} cy={opt.yZ} r="3.5" />
          </Way>
          <Way
            delay={0.16}
            foot={model ? `Lock about ${usd(model.forward)} a MWh` : 'Plan a hedge'}
            href="/hedge"
            text="Turn a power bill that moves every hour into one number you know today."
            title="Hedge"
          >
            <HedgeBars averages={averages.slice(-12)} />
          </Way>
          <Way
            delay={0.24}
            foot={open ? `${open} questions open` : 'Questions by day'}
            href="/trade"
            text="Will tomorrow average above $35? A share costs less than $1 and pays $1 if you are right."
            title="Yes / No"
          >
            <YesNoDots averages={averages.slice(-7)} />
          </Way>
        </div>
      </div>
    </section>
  );
}

function HedgeBars({ averages }: { averages: number[] }) {
  if (averages.length === 0) return null;
  const mx = Math.max(...averages) * 1.06;
  const mean = averages.reduce((a, b) => a + b, 0) / averages.length;
  const hL = (mean / mx) * 74;
  return (
    <>
      {averages.map((x, i) => {
        const h = Math.max(2, (x / mx) * 74);
        return (
          <rect
            className="hb"
            height={f1(h)}
            key={i}
            rx="2"
            style={
              {
                '--s': (hL / h).toFixed(4),
                transitionDelay: `${(i * 0.035).toFixed(3)}s`,
                animationDelay: `${(i * 0.05).toFixed(2)}s`,
              } as React.CSSProperties
            }
            width="12"
            x={f1(6 + i * 19.2)}
            y={f1(88 - h)}
          />
        );
      })}
      <path className="lvl" d={`M0 ${f1(88 - hL)}H240`} />
    </>
  );
}

function YesNoDots({ averages }: { averages: number[] }) {
  const T = 35;
  const yT = 48;
  return (
    <>
      <path className="lvl" d={`M0 ${yT}H240`} />
      {averages.map((x, i) => {
        const cx = 22 + i * 32.7;
        const y = Math.max(9, Math.min(87, yT - (x - T) * 2.6));
        const up = x > T;
        return (
          <g key={i}>
            <rect
              className={`st ${up ? 'up' : 'dn'}`}
              height={f1(Math.max(0.5, Math.abs(y - yT)))}
              style={{ animationDelay: `${(i * 0.07).toFixed(2)}s` }}
              width="1.6"
              x={f1(cx - 0.8)}
              y={f1(Math.min(y, yT))}
            />
            <circle
              className={`yd ${up ? 'up' : 'dn'}`}
              cx={f1(cx)}
              cy={f1(y)}
              r="4.5"
              style={{ animationDelay: `${(i * 0.07 + 0.25).toFixed(2)}s` }}
            />
          </g>
        );
      })}
    </>
  );
}

/** The last published day and how its Yes / No questions came out. */
function Settled() {
  const copy = useReveal<HTMLHeadingElement>();
  const card = useReveal<HTMLDivElement>();
  const records = useCommittedRecords('ERCOT_HBNORTH_DA_AVG');
  const { markets } = useMarkets();
  const last = useMemo(() => {
    const published = records?.filter((r) => r.txHash).sort((a, b) => b.dayKey - a.dayKey)[0];
    return published ? { dayKey: published.dayKey, value: published.value } : null;
  }, [records]);
  const questions = last && markets
    ? markets
        .filter((m) => m.metricId === 'ERCOT_HBNORTH_DA_AVG' && m.dayKey === last.dayKey)
        .sort((a, b) => a.threshold - b.threshold)
    : [];

  return (
    <section aria-label="How prices settle" className="settled">
      <div className="wrap">
        <div className="copy">
          <h2 data-reveal ref={copy}>
            One price, settled in public.
          </h2>
          <p>
            Each day&apos;s price comes from the Texas grid operator&apos;s own figures. It is published on chain and left
            open for an hour so anyone can check it before it becomes final.
          </p>
          <Link className="pill ghost" href="/proof" style={{ alignSelf: 'flex-start' }}>
            See every price
          </Link>
        </div>
        <div className="receipt" data-reveal ref={card}>
          {last ? (
            <>
              <div className="row">
                <span className="muted">Last published day</span>
                <span>{dayLong(last.dayKey)}</span>
              </div>
              <div className="row" style={{ justifyContent: 'flex-start', gap: 10 }}>
                <span className="big">{usd(last.value / 100)}</span>
                <span className="muted">day average per MWh</span>
              </div>
              {questions.length > 0 && <hr />}
              {questions.map((m) => {
                const yes = last.value > m.threshold;
                return (
                  <div className="row" key={m.address}>
                    <span className="muted">Above {usd(m.threshold / 100).replace('.00', '')}?</span>
                    <span className={yes ? 'yes' : 'no'}>{yes ? 'Yes' : 'No'}</span>
                  </div>
                );
              })}
            </>
          ) : (
            <div className="row">
              <span className="muted">Loading the last published day…</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
