'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { CommittedRecord } from '@/lib/feed-data';
import { dailyEnergy, optionHedge, perpHedge, scenarios, SCENARIO_PRICES, type Load, type Role } from '@/lib/hedge-v2';
import { bandedCall, bandedPut, forwardAndSigma } from '@/lib/option-pricing';
import recordsJson from '@/public/data/ERCOT_HBNORTH_DA_AVG.json';

const BAND = { floor: -50, cap: 300 };
const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
const price = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
const mwhs = (v: number) => `${(Math.round(v * 10) / 10).toLocaleString('en-US')} MWh`;

/** The 3D field's grid: one column per price from $0 to $150, one row per 5% of hedge. */
const COLS = 25;
const ROWS = 21;
const P1 = 150;

/** Daily averages in $/MWh, oldest first, as the site was built with. */
const history = (recordsJson as CommittedRecord[]).toSorted((a, b) => a.dayKey - b.dayKey).map((r) => r.value / 100);

function numberOr(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The hedge planner: the power you use or make in, a futures or options
 * trade out, with your day's cost or revenue at a range of prices with and
 * without it, and a 3D field of every price against every hedge level.
 * Pure calculation from the committed price history (lib/hedge-v2.ts), so it
 * works before the futures and options contracts are deployed.
 */
export function HedgePlanner() {
  const model = useMemo(() => forwardAndSigma(history, null), []);
  const forward = model?.forward ?? 40;
  const sigma = model?.sigma ?? 10;

  const [role, setRole] = useState<Role>('buyer');
  const [goal, setGoal] = useState<'lock' | 'cap'>('lock');
  const [mw, setMw] = useState('10');
  const [hours, setHours] = useState('24');
  const [share, setShare] = useState(100);
  const [level, setLevel] = useState('');

  const defaultLevel =
    goal === 'lock' ? Math.round(forward * 100) / 100 : Math.round((role === 'buyer' ? forward + 15 : forward - 10) / 5) * 5;
  const chosen = numberOr(level || String(defaultLevel), defaultLevel);
  const premium = goal === 'cap' ? (role === 'buyer' ? bandedCall(forward, chosen, sigma, BAND) : bandedPut(forward, chosen, sigma, BAND)) : 0;

  const plan = useMemo(() => {
    const at = (s: number) => {
      const load: Load = { role, mw: numberOr(mw, 0), hoursPerDay: numberOr(hours, 0), share: s };
      const hedge = goal === 'lock' ? perpHedge(load, chosen, BAND) : optionHedge(load, chosen, premium);
      return { load, hedge };
    };
    return { at, ...at(share / 100) };
  }, [role, mw, hours, share, goal, chosen, premium]);

  const energy = dailyEnergy(plan.load);
  const fr = Math.round(forward * 100) / 100;
  const prices = [...SCENARIO_PRICES, fr].sort((a, b) => a - b);
  const rows = scenarios(plan.load, plan.hedge, prices, BAND);
  const buyer = role === 'buyer';
  const word = buyer ? 'cost' : 'revenue';
  const part = share < 100 ? ', hedged part' : '';

  // the field: every price against every hedge level, as a share of the tallest bar
  const heights = useMemo(() => {
    const out = new Float32Array(COLS * ROWS);
    const mwh = dailyEnergy(plan.at(1).load).mwh;
    if (mwh <= 0) return out;
    const ps = Array.from({ length: COLS }, (_, c) => (P1 * c) / (COLS - 1));
    for (let rw = 0; rw < ROWS; rw++) {
      const { load, hedge } = plan.at(rw / (ROWS - 1));
      scenarios(load, hedge, ps, BAND).forEach((r, c) => {
        out[rw * COLS + c] = Math.max(0, r.hedged / (mwh * P1));
      });
    }
    return out;
  }, [plan]);

  const futuresHref = `/futures?side=${buyer ? 'long' : 'short'}&size=${Math.min(500, Math.round(energy.hedgedMwh))}`;
  const optionsHref = `/options?type=${buyer ? 'call' : 'put'}&strike=${Math.round(chosen / 5) * 5}&size=${Math.min(500, Math.round(energy.hedgedMwh))}`;

  return (
    <div className="page page-body enter">
      <div className="wrap">
        <div className="phead">
          <div>
            <p className="kicker">Hedge</p>
            <h1>Turn a moving power bill into one number.</h1>
          </div>
          <p className="lede">
            Tell us how much power you use or make. We build the trade that holds your daily {word}, and show what it does at
            every price.
          </p>
        </div>
        <div className="hgrid">
          <form aria-label="Your power" className="card hform" onSubmit={(e) => e.preventDefault()}>
            <Seg
              label="Role"
              on={buyer ? 0 : 1}
              options={['I use power', 'I produce power']}
              set={(i) => {
                setRole(i === 0 ? 'buyer' : 'producer');
                setLevel('');
              }}
            />
            <div className="two">
              <label className="fld">
                <span>Power</span>
                <span className="in">
                  <input inputMode="decimal" onChange={(e) => setMw(e.target.value)} value={mw} />
                  <em>MW</em>
                </span>
              </label>
              <label className="fld">
                <span>Hours a day</span>
                <span className="in">
                  <input inputMode="numeric" onChange={(e) => setHours(e.target.value)} value={hours} />
                  <em>h</em>
                </span>
              </label>
            </div>
            <div className="fld">
              <label className="fl" htmlFor="h-share">
                <span>How much to hedge</span>
                <b>{share}%</b>
              </label>
              <input id="h-share" max="100" min="0" onChange={(e) => setShare(Number(e.target.value))} step="5" type="range" value={share} />
            </div>
            <Seg
              label="Goal"
              on={goal === 'lock' ? 0 : 1}
              options={['Lock a price', buyer ? 'Cap my cost' : 'Set a floor']}
              set={(i) => {
                setGoal(i === 0 ? 'lock' : 'cap');
                setLevel('');
              }}
            />
            <label className="fld">
              <span>{goal === 'lock' ? 'Price to lock' : buyer ? 'Cap the price at' : 'Floor the price at'}</span>
              <span className="in">
                <em className="pre">$</em>
                <input inputMode="decimal" onChange={(e) => setLevel(e.target.value)} placeholder={defaultLevel.toFixed(2)} value={level} />
                <em>per MWh</em>
              </span>
            </label>
            <p className="fine">
              Expected day average {price(forward)} from the last {Math.min(14, history.length)} days, typical miss {price(sigma)}.
              Option prices are the pool&apos;s own model; futures are fully backed.
            </p>
          </form>
          <Field buyer={buyer} heights={heights} planRow={Math.round((share / 100) * (ROWS - 1))} plan={plan} />
        </div>
        <Reveal className="hstats">
          <div>
            <span>Energy a day</span>
            <b>{mwhs(energy.mwh)}</b>
          </div>
          <div>
            <span>Hedged a day</span>
            <b>{mwhs(energy.hedgedMwh)}</b>
          </div>
          {plan.hedge.kind === 'perp' ? (
            <>
              <div>
                <span>Trade</span>
                <b>
                  {plan.hedge.side === 'long' ? 'Long' : 'Short'} futures at {price(plan.hedge.entryPrice)}
                </b>
              </div>
              <div>
                <span>Held as backing</span>
                <b>{money(plan.hedge.collateral)}</b>
              </div>
              <div>
                <span>Locked price{part}</span>
                <b>{price(plan.hedge.entryPrice)}</b>
              </div>
            </>
          ) : (
            <>
              <div>
                <span>Trade</span>
                <b>
                  {plan.hedge.type === 'call' ? 'Calls' : 'Puts'} at {price(plan.hedge.strike)}
                </b>
              </div>
              <div>
                <span>Premium a day</span>
                <b>{money(plan.hedge.premium)}</b>
              </div>
              <div>
                <span>
                  {buyer ? 'Worst price' : 'Floor price'}
                  {part}
                </span>
                <b>{price(plan.hedge.effectivePrice)}</b>
              </div>
            </>
          )}
        </Reveal>
        <Reveal className="hscen">
          <div className="pos-head">
            <h3>Your day at different prices</h3>
            <Link className="pill solid" href={goal === 'lock' ? futuresHref : optionsHref}>
              {goal === 'lock' ? 'Open this in futures' : 'Open this in options'}
            </Link>
          </div>
          <div className="tbl">
            <table>
              <thead>
                <tr>
                  <th scope="col">If the day averages</th>
                  <th scope="col">{buyer ? 'Cost' : 'Revenue'} without hedge</th>
                  <th scope="col">{buyer ? 'Cost' : 'Revenue'} with hedge</th>
                  <th scope="col">Difference</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const diff = buyer ? r.unhedged - r.hedged : r.hedged - r.unhedged;
                  const at = r.price === fr;
                  const same = Math.abs(diff) < 0.5;
                  return (
                    <tr className={at ? 'at' : undefined} key={r.price}>
                      <td>
                        {price(r.price)} {at && <span className="muted">expected</span>}
                      </td>
                      <td>{money(r.unhedged)}</td>
                      <td>{money(r.hedged)}</td>
                      <td className={same ? '' : diff > 0 ? 'save' : 'cost'}>
                        {same
                          ? 'Same'
                          : diff > 0
                            ? `${buyer ? 'You save' : 'You gain'} ${money(diff)}`
                            : `${buyer ? 'Costs' : 'Gives up'} ${money(-diff)}${buyer ? ' more' : ''}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="fine" style={{ marginTop: 14 }}>
            Both markets settle on prices inside −$50 to $300, so beyond that the hedge stops paying more. The hub price is not
            your own connection point, and a flat daily average does not follow a solar or night-time profile. Fees and funding
            are not included. X Layer testnet, test money only.
          </p>
        </Reveal>
      </div>
    </div>
  );
}

function Seg({ label, options, on, set }: { label: string; options: string[]; on: number; set: (i: number) => void }) {
  return (
    <fieldset aria-label={label} className="seg" data-on={on}>
      <span aria-hidden className="thumb" />
      {options.map((o, i) => (
        <button aria-pressed={on === i} key={o} onClick={() => set(i)} type="button">
          {o}
        </button>
      ))}
    </fieldset>
  );
}

function Reveal({ className, children }: { className: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.classList.add('revealed');
      return;
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          el.classList.add('revealed');
          io.disconnect();
        }
      },
      { threshold: 0.08 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div className={className} data-reveal ref={ref}>
      {children}
    </div>
  );
}

interface FieldControls {
  update: (heights: Float32Array, row: number) => void;
  destroy: () => void;
}

function Field({
  heights,
  planRow,
  plan,
  buyer,
}: {
  heights: Float32Array;
  planRow: number;
  plan: { at: (s: number) => { load: Load; hedge: ReturnType<typeof perpHedge> | ReturnType<typeof optionHedge> } };
  buyer: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const readEl = useRef<HTMLSpanElement>(null);
  const field = useRef<FieldControls | null>(null);
  const planRef = useRef(plan);
  const latest = useRef({ heights, planRow });
  useEffect(() => {
    planRef.current = plan;
    latest.current = { heights, planRow };
  });

  useEffect(() => {
    const root = box.current;
    if (!root) return;
    let cancelled = false;
    void import('@/components/qg/hedge-field.js').then(({ mountField }) => {
      if (cancelled) return;
      field.current = mountField(root, {
        readEl: readEl.current,
        read: (s: number, P: number) => {
          const { load, hedge } = planRef.current.at(s);
          const v = scenarios(load, hedge, [P], BAND)[0].hedged;
          return `At ${price(P)}, ${Math.round(s * 100)}% hedged: ${money(v)} a day`;
        },
      }) as FieldControls;
      field.current.update(latest.current.heights, latest.current.planRow);
    });
    return () => {
      cancelled = true;
      field.current?.destroy();
      field.current = null;
    };
  }, []);

  useEffect(() => {
    field.current?.update(heights, planRow);
  }, [heights, planRow]);

  return (
    <section aria-label="Daily cost at every price and hedge level" className="card surf">
      <div className="shd">
        <div>
          <b>{buyer ? 'Your daily cost' : 'Your daily revenue'}</b>
          <span className="muted">at prices from $0 to $150, one row per hedge level</span>
        </div>
        <span aria-live="polite" className="read" ref={readEl} />
      </div>
      <div className="surfwrap" ref={box}>
        <canvas aria-hidden className="h-3d" />
        <p className="sr-only">A 3D field of your daily {buyer ? 'cost' : 'revenue'} at prices from $0 to $150 for every hedge level; the table below has the same numbers.</p>
        <div aria-hidden className="tags" data-f="tags" />
        <span className="chint">Drag to turn. Point at a bar to read it.</span>
      </div>
      <div className="pkey">
        <span>
          <i className="k-g" />
          Your plan
        </span>
        <span>
          <i className="k-l" />
          No hedge
        </span>
      </div>
    </section>
  );
}
