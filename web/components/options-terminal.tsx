'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';

import { PayoffChart } from '@/components/qg/payoff-chart';
import { useContractWriter } from '@/components/use-contract-writer';
import { deployed, optionsAbi, readOptionsBoard, type OptionExpiry, type OptionRow, type OptionsBoard } from '@/lib/derivatives';
import { forwardAndSigma, normalCdf, quoteStrike } from '@/lib/option-pricing';
import { buyPreview, closeLabel, dayLabel, defaultLimitCents, maxPayoutCents, strikeGrid } from '@/lib/options-view';
import { dollars, mwhLabel, priceCents, sizeUnits } from '@/lib/perp-view';
import { useCommittedRecords } from '@/lib/site-data';

const POLL_MS = 30_000;
const BAND_CENTS = { floorCents: -5000, capCents: 30_000 };
const usd = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cents = (c: number) => usd(c / 100);
const pct = (p: number) => (p < 0.01 ? 'under 1%' : p > 0.99 ? 'over 99%' : `${Math.round(p * 100)}%`);

/** Day keys for the next `n` days after `from` (a dayKey). */
function nextDays(from: number, n: number): number[] {
  const d = new Date(Date.UTC(Math.floor(from / 10_000), Math.floor((from % 10_000) / 100) - 1, from % 100));
  return Array.from({ length: n }, () => {
    d.setUTCDate(d.getUTCDate() + 1);
    return d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  });
}

/** 12:30 Texas time on the day before `dayKey`, when the day-ahead auction reveals the price. */
function closeBefore(dayKey: number): number {
  const y = Math.floor(dayKey / 10_000);
  const m = Math.floor((dayKey % 10_000) / 100) - 1;
  const d = dayKey % 100;
  // Texas is UTC-6 in winter and UTC-5 in summer; read the offset for that date
  const probe = new Date(Date.UTC(y, m, d - 1, 18, 30));
  const tx = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(probe);
  return Math.floor(probe.getTime() / 1000) - (Number(tx) - 12) * 3600;
}

/**
 * The options screen: the expected day average, the day to settle on, what
 * the chosen option pays at every price, every strike's quotes, and the
 * ticket. Live quotes and orders come from TexasPowerOptions once it is on X
 * Layer testnet; until then the quotes are the pool's own model on the
 * committed day averages, and buying says the market opens soon.
 */
export function OptionsTerminal() {
  const { options, collateral } = deployed;
  const writer = useContractWriter();
  const records = useCommittedRecords('ERCOT_HBNORTH_DA_AVG');
  const [nowSec, setNowSec] = useState(0);
  useEffect(() => {
    const tick = () => setNowSec(Date.now() / 1000);
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);
  const grid = useMemo(() => strikeGrid(BAND_CENTS), []);
  const [liveBoard, setLiveBoard] = useState<OptionsBoard | null>(null);
  const [readError, setReadError] = useState<string>();

  const refresh = useCallback(async () => {
    if (!options) return;
    try {
      setLiveBoard(await readOptionsBoard(options, writer.account, Date.now(), grid));
      setReadError(undefined);
    } catch {
      setReadError('Could not read the options from X Layer; retrying.');
    }
  }, [options, writer.account, grid]);

  useEffect(() => {
    if (!options) return;
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [options, refresh]);

  const model = useMemo(() => {
    if (!records || records.length < 3) return null;
    const sorted = [...records].sort((a, b) => a.dayKey - b.dayKey);
    const fs = forwardAndSigma(sorted.map((r) => r.value / 100), null);
    return fs ? { ...fs, lastDay: sorted[sorted.length - 1].dayKey } : null;
  }, [records]);

  // until the contract is live: the model's quotes for the next seven days, strikes around the expected price
  const modelBoard = useMemo<OptionsBoard | null>(() => {
    if (!model) return null;
    const k0 = Math.round(model.forward / 5) * 5;
    const strikes: number[] = [];
    for (let k = k0 - 35; k <= k0 + 35; k += 5) if (k >= 5) strikes.push(k);
    const rows: OptionRow[] = strikes.map((k) => {
      const q = quoteStrike(model.forward, k, model.sigma, { floor: -50, cap: 300 });
      return { strikeCents: k * 100, ...q, myCall: 0n, myPut: 0n };
    });
    // the seven days after the latest known one whose trading has not closed yet
    const expiries: OptionExpiry[] = nextDays(model.lastDay, 8)
      .map((dayKey) => ({ dayKey, closeUtc: closeBefore(dayKey), version: 0n, rows }))
      .filter((e) => e.closeUtc > nowSec)
      .slice(0, 7);
    return { band: BAND_CENTS, paused: false, freePool: 0n, expiries, toClaim: [] };
  }, [model, nowSec]);

  const live = Boolean(options && collateral);
  const board = live ? liveBoard : modelBoard;
  const [day, setDay] = useState<number | null>(null);
  const [pick, setPick] = useState<{ strikeCents: number; isCall: boolean } | null>(null);
  const [size, setSize] = useState('10');

  // the hedge planner links here with ?type=&strike=&size= to start with its option
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const type = q.get('type');
    const strike = Number(q.get('strike'));
    const s = q.get('size');
    const t = setTimeout(() => {
      if (s && Number(s) > 0) setSize(s);
      if ((type === 'call' || type === 'put') && strike > 0) setPick({ strikeCents: strike * 100, isCall: type === 'call' });
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const expiry = board?.expiries.find((e) => e.dayKey === day) ?? board?.expiries[0] ?? null;
  const rows = expiry?.rows ?? [];
  const forward = model?.forward ?? 40;
  const sigma = model?.sigma ?? 10;
  const defaultStrike = rows.length ? rows.reduce((a, r) => (Math.abs(r.strikeCents / 100 - (forward + 5)) < Math.abs(a.strikeCents / 100 - (forward + 5)) ? r : a), rows[0]).strikeCents : null;
  const picked = pick && rows.some((r) => r.strikeCents === pick.strikeCents) ? pick : null;
  const sel = picked ?? (defaultStrike === null ? null : { strikeCents: defaultStrike, isCall: pick?.isCall ?? true });
  const row = sel ? rows.find((r) => r.strikeCents === sel.strikeCents) ?? null : null;

  return (
    <div className="term page-body enter">
      <div className="wrap">
        <section aria-label="Texas power options" className="main">
          <div className="inst">
            <div>
              <div className="lab">Texas power options, North Hub day average</div>
              <div className="price">
                <span className="v">{model ? usd(forward) : '—'}</span>
                <span className="u">expected day average</span>
              </div>
              <div className="chg">
                <span className="muted">
                  {model ? `From the last 14 days. A typical day lands within ${usd(sigma)} of it.` : 'Reading the day averages…'}
                </span>
                {!live && (
                  <span className="badge wait">
                    <i />
                    Model quotes, opening on testnet
                  </span>
                )}
                {liveBoard?.paused && <span className="no">Paused</span>}
              </div>
            </div>
            {board && board.expiries.length > 0 && (
              <fieldset aria-label="Settlement day" className="exp">
                {board.expiries.map((e) => {
                  const [wd, dd, mo] = dayLabel(e.dayKey).split(' ');
                  return (
                    <button
                      aria-pressed={e.dayKey === expiry?.dayKey}
                      key={e.dayKey}
                      onClick={() => {
                        setDay(e.dayKey);
                        setPick(null);
                      }}
                      type="button"
                    >
                      {wd} {dd}
                      <small>{mo}</small>
                    </button>
                  );
                })}
              </fieldset>
            )}
          </div>
          {readError && <p className="fine no">{readError}</p>}
          {board && board.expiries.length === 0 && <p className="muted">No day is trading right now.</p>}
          {sel && row && expiry && (
            <PayoffChart
              band={{ floor: board!.band.floorCents / 100, cap: board!.band.capCents / 100 }}
              forward={forward}
              isCall={sel.isCall}
              premium={(sel.isCall ? row.callAsk : row.putAsk) / 100}
              sigma={sigma}
              sizeMwh={Number(size) > 0 ? Number(size) : 1}
              strike={sel.strikeCents / 100}
              title={`What ${Number(size) > 0 ? size : 1} MWh of $${sel.strikeCents / 100} ${sel.isCall ? 'calls' : 'puts'} pays on ${dayLabel(expiry.dayKey)}`}
            />
          )}
          {expiry && (
            <Chain
              closeUtc={expiry.closeUtc}
              forward={forward}
              live={live}
              onPick={(strikeCents, isCall) => setPick({ strikeCents, isCall })}
              rows={rows}
              sel={sel}
              sigma={sigma}
            />
          )}
          {live && liveBoard && liveBoard.toClaim.length > 0 && (
            <section aria-label="Past days to claim" className="pos">
              <div className="pos-head">
                <h3>Past days to claim</h3>
              </div>
              <div className="tbl">
                <table>
                  <tbody>
                    {liveBoard.toClaim.map((h) => (
                      <tr key={`${h.dayKey}-${h.strikeCents}-${h.isCall}`}>
                        <td>
                          {dayLabel(h.dayKey)} {cents(h.strikeCents)} {h.isCall ? 'call' : 'put'}, {mwhLabel(h.size)}
                        </td>
                        <td>
                          <button
                            className="mini"
                            disabled={Boolean(writer.pending)}
                            onClick={async () => {
                              if (
                                await writer.send('Claiming', {
                                  address: options!,
                                  abi: optionsAbi,
                                  functionName: 'claim',
                                  args: [h.dayKey, BigInt(h.strikeCents), h.isCall],
                                })
                              )
                                void refresh();
                            }}
                            title="Pays once the day's price is final on chain"
                            type="button"
                          >
                            Claim
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </section>
        {sel && row && expiry && board ? (
          <Ticket
            band={board.band}
            collateral={collateral ?? undefined}
            dayKey={expiry.dayKey}
            forward={forward}
            live={live}
            onDone={() => void refresh()}
            options={options ?? undefined}
            row={row}
            sel={sel}
            setPick={setPick}
            setSize={setSize}
            sigma={sigma}
            size={size}
            strikes={rows.map((r) => r.strikeCents)}
            writer={writer}
          />
        ) : (
          <aside className="ticket">
            <p className="say">Reading the quotes…</p>
          </aside>
        )}
      </div>
    </div>
  );
}

function Chain({
  rows,
  closeUtc,
  sel,
  onPick,
  forward,
  sigma,
  live,
}: {
  rows: OptionRow[];
  closeUtc: number;
  sel: { strikeCents: number; isCall: boolean } | null;
  onPick: (strikeCents: number, isCall: boolean) => void;
  forward: number;
  sigma: number;
  live: boolean;
}) {
  const fwdAt = rows.findIndex((r) => r.strikeCents / 100 > forward);
  return (
    <section aria-label="Option chain">
      <div className="pos-head">
        <h3>All strikes</h3>
        <span className="muted" style={{ fontSize: 14 }}>
          Prices per MWh. Trading stops {closeLabel(closeUtc)} Texas time.
        </span>
      </div>
      <div className="tbl chain">
        <table>
          <thead>
            <tr className="grp">
              <th className="cg" colSpan={3} scope="colgroup">
                Calls pay above
              </th>
              <th className="kc" scope="col">
                <span className="sr-only">Strike</span>
              </th>
              <th className="pg" colSpan={3} scope="colgroup">
                Puts pay below
              </th>
            </tr>
            <tr>
              <th scope="col">Chance</th>
              <th scope="col">Bid</th>
              <th scope="col">Ask</th>
              <th className="kc" scope="col">
                Strike
              </th>
              <th scope="col">Bid</th>
              <th scope="col">Ask</th>
              <th scope="col">Chance</th>
            </tr>
          </thead>
          <tbody>
            {rows.flatMap((r, idx) => {
              const k = r.strikeCents / 100;
              const pc = 1 - normalCdf((k - forward) / sigma);
              const ic = k < forward ? 'itm-c' : '';
              const ip = k > forward ? 'itm-p' : '';
              const out = [];
              if (idx === fwdAt) {
                out.push(
                  <tr aria-hidden className="fwd" key="fwd">
                    <td colSpan={7}>
                      <div />
                      <span>Expected {usd(forward)}</span>
                    </td>
                  </tr>,
                );
              }
              const held = live && (r.myCall > 0n || r.myPut > 0n);
              out.push(
                <tr key={r.strikeCents}>
                  <td className={ic}>{pct(pc)}</td>
                  <td className={ic}>{r.callBid ? cents(r.callBid) : '–'}</td>
                  <td className={ic}>
                    <button
                      aria-label={`Buy $${k} call at ${cents(r.callAsk)}`}
                      aria-pressed={sel?.strikeCents === r.strikeCents && sel.isCall}
                      className="qb"
                      disabled={r.callAsk === 0}
                      onClick={() => onPick(r.strikeCents, true)}
                      type="button"
                    >
                      {r.callAsk === 0 ? '–' : cents(r.callAsk)}
                    </button>
                  </td>
                  <td className="kc" title={held ? `You hold ${[r.myCall > 0n && `${mwhLabel(r.myCall)} call`, r.myPut > 0n && `${mwhLabel(r.myPut)} put`].filter(Boolean).join(', ')}` : undefined}>
                    ${k}
                    {held ? ' •' : ''}
                  </td>
                  <td className={ip}>{r.putBid ? cents(r.putBid) : '–'}</td>
                  <td className={ip}>
                    <button
                      aria-label={`Buy $${k} put at ${cents(r.putAsk)}`}
                      aria-pressed={sel?.strikeCents === r.strikeCents && !sel.isCall}
                      className="qb"
                      disabled={r.putAsk === 0}
                      onClick={() => onPick(r.strikeCents, false)}
                      type="button"
                    >
                      {r.putAsk === 0 ? '–' : cents(r.putAsk)}
                    </button>
                  </td>
                  <td className={ip}>{pct(1 - pc)}</td>
                </tr>,
              );
              return out;
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Ticket({
  options,
  collateral,
  band,
  row,
  sel,
  dayKey,
  live,
  writer,
  forward,
  sigma,
  size,
  setSize,
  setPick,
  strikes,
  onDone,
}: {
  options?: Address;
  collateral?: Address;
  band: { floorCents: number; capCents: number };
  row: OptionRow;
  sel: { strikeCents: number; isCall: boolean };
  dayKey: number;
  live: boolean;
  writer: ReturnType<typeof useContractWriter>;
  forward: number;
  sigma: number;
  size: string;
  setSize: (s: string) => void;
  setPick: (p: { strikeCents: number; isCall: boolean }) => void;
  strikes: number[];
  onDone: () => void;
}) {
  const [mode, setMode] = useState<'buy' | 'sell'>('buy');
  const [limit, setLimit] = useState('');
  const { isCall, strikeCents } = sel;
  const ask = isCall ? row.callAsk : row.putAsk;
  const bid = isCall ? row.callBid : row.putBid;
  const held = isCall ? row.myCall : row.myPut;
  const max = maxPayoutCents(strikeCents, isCall, band);
  const limitCents =
    priceCents(limit) ?? (mode === 'buy' ? defaultLimitCents(ask, max) : Math.max(0, bid - Math.max(1, Math.ceil(bid * 0.05))));
  const units = sizeUnits(size);
  const preview = buyPreview({ size: units, askCents: ask, limitCents, strikeCents, isCall, band });
  const sellProblem =
    mode === 'sell' &&
    (units === null || units < 100n
      ? 'Size is at least 0.1 MWh.'
      : units > held
        ? `You hold ${mwhLabel(held)}.`
        : bid === 0
          ? 'The pool is not bidding for this option now.'
          : null);
  const k = strikeCents / 100;
  const z = (k - forward) / sigma;
  const chance = isCall ? 1 - normalCdf(z) : normalCdf(z);
  const be = isCall ? k + ask / 100 : k - ask / 100;
  const n = Number(size);
  const sizeOk = Number.isFinite(n) && n >= 0.1;
  const stepStrike = (dir: number) => {
    const i = strikes.indexOf(strikeCents) + dir;
    if (i >= 0 && i < strikes.length) setPick({ strikeCents: strikes[i], isCall });
  };

  const submit = async () => {
    if (!options || !collateral || !units) return;
    if (mode === 'buy') {
      if (preview.problem) return;
      if (!(await writer.ensureAllowance(collateral, options, preview.escrow))) return;
      if (await writer.send('Buying', { address: options, abi: optionsAbi, functionName: 'requestBuy', args: [dayKey, BigInt(strikeCents), isCall, units, BigInt(limitCents)] }))
        onDone();
    } else {
      if (sellProblem) return;
      if (await writer.send('Selling', { address: options, abi: optionsAbi, functionName: 'requestSell', args: [dayKey, BigInt(strikeCents), isCall, units, BigInt(limitCents)] }))
        onDone();
    }
  };

  return (
    <aside aria-label="Buy an option" className="ticket">
      <fieldset aria-label="Option type" className="seg tone" data-on={isCall ? 0 : 1}>
        <span aria-hidden className="thumb" />
        <button aria-pressed={isCall} onClick={() => setPick({ strikeCents, isCall: true })} type="button">
          Calls
        </button>
        <button aria-pressed={!isCall} onClick={() => setPick({ strikeCents, isCall: false })} type="button">
          Puts
        </button>
      </fieldset>
      <div className="stepper">
        <span className="lab">Strike</span>
        <div className="row">
          <button aria-label="Lower strike" className="sq" onClick={() => stepStrike(-1)} type="button">
            −
          </button>
          <b>${k}</b>
          <button aria-label="Higher strike" className="sq" onClick={() => stepStrike(1)} type="button">
            +
          </button>
        </div>
      </div>
      <p className="say">
        Pays if {dayLabel(dayKey)} averages {isCall ? 'above' : 'below'} ${k}: the gap, on every MWh, at most {cents(max)}.
      </p>
      {live && held > 0n && (
        <fieldset aria-label="Buy or sell" className="seg" data-on={mode === 'buy' ? 0 : 1}>
          <span aria-hidden className="thumb" />
          <button aria-pressed={mode === 'buy'} onClick={() => setMode('buy')} type="button">
            Buy
          </button>
          <button aria-pressed={mode === 'sell'} onClick={() => setMode('sell')} type="button">
            Sell back
          </button>
        </fieldset>
      )}
      <div className="qty">
        <label className="lab" htmlFor="o-size">
          How much power
        </label>
        <div className="num">
          <input id="o-size" inputMode="decimal" onChange={(e) => setSize(e.target.value)} style={{ width: `${Math.max(2, size.length) + 0.4}ch` }} value={size} />
          <span className="u">MWh</span>
        </div>
        <input aria-label="Size in MWh" max="200" min="1" onChange={(e) => setSize(e.target.value)} type="range" value={Math.min(200, Math.max(1, Math.round(n) || 1))} />
      </div>
      <details className="limit">
        <summary>
          {mode === 'buy' ? 'Most you pay' : 'Least you accept'}: {cents(limitCents)} a MWh
        </summary>
        <label className="fld">
          <span>{mode === 'buy' ? 'Most you pay, per MWh' : 'Least you accept, per MWh'}</span>
          <span className="in">
            <em className="pre">$</em>
            <input inputMode="decimal" onChange={(e) => setLimit(e.target.value)} placeholder={(limitCents / 100).toFixed(2)} value={limit} />
          </span>
        </label>
      </details>
      <dl className="sum">
        <div>
          <dt>Price per MWh</dt>
          <dd>{cents(mode === 'buy' ? ask : bid)}</dd>
        </div>
        <div>
          <dt>{mode === 'buy' ? 'You pay' : 'You get'}</dt>
          <dd>{sizeOk ? usd(((mode === 'buy' ? ask : bid) / 100) * n) : '—'}</dd>
        </div>
        <div>
          <dt>Most it pays</dt>
          <dd>{sizeOk ? dollars(preview.maxPayout) : '—'}</dd>
        </div>
        <div>
          <dt>Breaks even at</dt>
          <dd>{usd(be)}</dd>
        </div>
        <div>
          <dt>Chance it pays, by the model</dt>
          <dd>{pct(chance)}</dd>
        </div>
      </dl>
      {live && (mode === 'buy' ? preview.problem : sellProblem) && <p className="fine no">{mode === 'buy' ? preview.problem : sellProblem}</p>}
      {writer.error && <p className="fine no">{writer.error}</p>}
      {!live ? (
        <button className={`go${isCall ? '' : ' put'}`} disabled type="button">
          Options open on testnet soon
        </button>
      ) : writer.account ? (
        <button
          className={`go${isCall ? '' : ' put'}`}
          disabled={Boolean(writer.pending) || Boolean(mode === 'buy' ? preview.problem : sellProblem)}
          onClick={() => void submit()}
          type="button"
        >
          {writer.pending ?? (mode === 'buy' ? `Buy ${size} MWh of $${k} ${isCall ? 'calls' : 'puts'}` : 'Sell back')}
        </button>
      ) : (
        <button className="go neutral" onClick={() => void writer.connect()} type="button">
          Connect wallet
        </button>
      )}
      <p className="fine">
        Settles on the day&apos;s average price from the grid operator. The most you can lose is what you pay. Fills at the
        next quotes, within about 5 minutes; beyond your limit it cancels and everything comes back.
      </p>
    </aside>
  );
}
