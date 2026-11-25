'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';

import { ProChart, useLastCandle, type ChartPosition } from '@/components/qg/pro-chart';
import { useLivePrice } from '@/components/qg/use-live-price';
import { useContractWriter } from '@/components/use-contract-writer';
import {
  deployed,
  perpAbi,
  readMyPerp,
  readPerpMarket,
  type MyOrder,
  type MyPosition,
  type PerpMarket,
} from '@/lib/derivatives';
import { dollars, mwhLabel, perpTicket, positionAt, priceCents, sizeUnits, type Side } from '@/lib/perp-view';

const POLL_MS = 15_000;
/** The price band the futures settle inside (contracts/README.md). */
const BAND = { floorCents: -5000, capCents: 30_000 };
const usd = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cents = (c: number) => usd(c / 100);

/**
 * The futures screen: the live Texas price, the chart with drawing tools, your
 * positions, and the order ticket. Until the futures contracts are on X Layer
 * testnet the ticket shows what an order would hold and pay, and its button
 * says the market opens soon.
 */
export function FuturesTerminal() {
  const { perp, feed, collateral } = deployed;
  const writer = useContractWriter();
  const [market, setMarket] = useState<PerpMarket | null>(null);
  const [mine, setMine] = useState<{ positions: MyPosition[]; orders: MyOrder[] }>({ positions: [], orders: [] });
  const [readError, setReadError] = useState<string>();
  const { live, stale } = useLivePrice();
  const [size, setSize] = useState('10');
  const [initialSide, setInitialSide] = useState<Side>();

  // the hedge planner links here with ?side=&size= to start the ticket with its trade
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const s = q.get('size');
    const sd = q.get('side');
    const t = setTimeout(() => {
      if (s && Number(s) > 0) setSize(s);
      if (sd === 'long' || sd === 'short') setInitialSide(sd);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const refresh = useCallback(async () => {
    if (!perp || !feed) return;
    try {
      setMarket(await readPerpMarket(perp, feed));
      if (writer.account) setMine(await readMyPerp(perp, writer.account));
      setReadError(undefined);
    } catch {
      setReadError('Could not read the market from X Layer; retrying.');
    }
  }, [perp, feed, writer.account]);

  useEffect(() => {
    if (!perp) return;
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [perp, refresh]);

  const lastCandle = useLastCandle();
  const shown = live ? live.price : lastCandle ? lastCandle.close : null;
  const indexCents = market?.indexCents ?? (shown === null ? null : Math.round(shown * 100));
  const dayAgo = lastCandle?.dayAgo ?? null;
  const change = shown !== null && dayAgo !== null ? shown - dayAgo : null;
  const chartPositions = useMemo<ChartPosition[]>(
    () =>
      mine.positions.map((p) => {
        const at =
          market?.indexCents == null ? null : positionAt(p, market.indexCents, market.band, market.feeBps);
        return {
          price: p.entryPriceCents / 100,
          long: p.isLong,
          title: `${p.isLong ? 'Long' : 'Short'} ${mwhLabel(p.size)}${at ? `  ${dollars(at.pnl)}` : ''}`,
        };
      }),
    [mine.positions, market],
  );

  return (
    <div className="term page-body enter">
      <div className="wrap">
        <section aria-label="Texas power futures" className="main">
          <div className="inst">
            <div>
              <div className="lab">Texas power, North Hub</div>
              <div aria-live="polite" className="price">
                <span className="v">{indexCents === null ? '—' : cents(indexCents)}</span>
                <span className="u">per MWh</span>
              </div>
              <div className="chg">
                {change !== null && market?.indexCents == null && (
                  <span className={change >= 0 ? 'yes' : 'no'}>
                    {change >= 0 ? '+' : '-'}${Math.abs(change).toFixed(2)} ({change >= 0 ? '+' : ''}
                    {((change / Math.abs(dayAgo || 1)) * 100).toFixed(1)}%) in 24 hours
                  </span>
                )}
                <span className="muted">
                  {market?.indexCents != null
                    ? '15-minute index, the price orders fill against'
                    : live
                      ? stale
                        ? 'Last 5-minute price, delayed'
                        : 'Real time, every 5 minutes'
                      : 'Last 15-minute ERCOT price'}
                </span>
                {market?.paused && <span className="no">Opening paused</span>}
              </div>
            </div>
          </div>
          <ProChart positions={chartPositions} size={Number(size) || 10} />
          <p className="credit">
            Chart library by{' '}
            <a href="https://www.tradingview.com/" rel="noopener" target="_blank">
              TradingView
            </a>
            .
          </p>
          {readError && <p className="fine no">{readError}</p>}
          {perp ? (
            <>
              <Positions
                busy={Boolean(writer.pending)}
                market={market}
                onClose={async (id) => {
                  if (await writer.send('Asking to close', { address: perp, abi: perpAbi, functionName: 'requestClose', args: [id] }))
                    void refresh();
                }}
                positions={mine.positions}
              />
              <Orders
                busy={Boolean(writer.pending)}
                onCancel={async (id) => {
                  if (await writer.send('Cancelling', { address: perp, abi: perpAbi, functionName: 'cancelOrder', args: [id] }))
                    void refresh();
                }}
                orders={mine.orders}
              />
              {market && <MarketFacts market={market} />}
            </>
          ) : (
            <OpeningFacts />
          )}
        </section>
        <Ticket
          collateral={collateral ?? undefined}
          indexCents={indexCents}
          initialSide={initialSide}
          market={market}
          onPlaced={() => void refresh()}
          perp={perp ?? undefined}
          setSize={setSize}
          size={size}
          writer={writer}
        />
      </div>
    </div>
  );
}

function OpeningFacts() {
  return (
    <section aria-label="How the futures work" className="pos">
      <div className="pos-head">
        <h3>How it works</h3>
        <span className="badge wait">
          <i />
          Opening on testnet
        </span>
      </div>
      <div className="hstats">
        <div>
          <span>Price band</span>
          <b>−$50 to $300</b>
        </div>
        <div>
          <span>Size</span>
          <b>from 0.1 MWh</b>
        </div>
        <div>
          <span>Fills at</span>
          <b>the next 5-minute price</b>
        </div>
        <div>
          <span>Expiry</span>
          <b>none</b>
        </div>
        <div>
          <span>Fee</span>
          <b>0.10% each way</b>
        </div>
      </div>
      <p className="fine" style={{ marginTop: 14 }}>
        Go long or short on the live ERCOT North Hub price, with no expiry. Fully backed: you put in your largest possible
        loss inside the band and the pool sets aside your largest possible gain, so there is no leverage and no
        liquidation. The contracts are built and tested and are in review before they go on X Layer testnet. Test money
        only.
      </p>
    </section>
  );
}

function MarketFacts({ market }: { market: PerpMarket }) {
  return (
    <div className="hstats">
      <div>
        <span>Band</span>
        <b>
          {cents(market.band.floorCents)} to {cents(market.band.capCents)}
        </b>
      </div>
      <div>
        <span>Pool free</span>
        <b>{dollars(market.freePool)}</b>
      </div>
      <div>
        <span>Long / short</span>
        <b>
          {mwhLabel(market.longSize)} / {mwhLabel(market.shortSize)}
        </b>
      </div>
      <div>
        <span>Funding per MWh an hour</span>
        <b>
          {market.fundingCentsPerMwhHour >= 0 ? 'longs pay' : 'shorts pay'} {Math.abs(market.fundingCentsPerMwhHour).toFixed(3)}¢
        </b>
      </div>
      <div>
        <span>Fee</span>
        <b>{(market.feeBps / 100).toFixed(2)}%</b>
      </div>
    </div>
  );
}

function Positions({
  positions,
  market,
  busy,
  onClose,
}: {
  positions: MyPosition[];
  market: PerpMarket | null;
  busy: boolean;
  onClose: (id: bigint) => void;
}) {
  return (
    <section aria-label="Your positions" className="pos">
      <div className="pos-head">
        <h3>Your positions</h3>
      </div>
      <div className="tbl">
        <table>
          <thead>
            <tr>
              <th scope="col">Side</th>
              <th scope="col">Size</th>
              <th scope="col">Opened at</th>
              <th scope="col">Result</th>
              <th scope="col">Funding</th>
              <th scope="col">If closed now</th>
              <th scope="col">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {positions.length === 0 && (
              <tr className="none">
                <td colSpan={7}>No open positions. Pick a side in the ticket to open one.</td>
              </tr>
            )}
            {positions.map((p) => {
              const at = market?.indexCents == null ? null : positionAt(p, market.indexCents, market.band, market.feeBps);
              return (
                <tr key={p.id.toString()}>
                  <td>
                    <span className={p.isLong ? 'side-l' : 'side-s'}>{p.isLong ? 'Long' : 'Short'}</span>
                  </td>
                  <td>{mwhLabel(p.size)}</td>
                  <td>{cents(p.entryPriceCents)}</td>
                  <td className={at ? (at.pnl > 0n ? 'yes' : at.pnl < 0n ? 'no' : '') : ''}>{at ? dollars(at.pnl) : '—'}</td>
                  <td>{dollars(-p.fundingOwed)}</td>
                  <td>{at ? dollars(at.payout > p.fundingOwed ? at.payout - p.fundingOwed : 0n) : '—'}</td>
                  <td>
                    {p.closePending ? (
                      <span className="muted">Closing at the next price</span>
                    ) : (
                      <button className="mini" disabled={busy} onClick={() => onClose(p.id)} type="button">
                        Close
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Orders({ orders, busy, onCancel }: { orders: MyOrder[]; busy: boolean; onCancel: (id: bigint) => void }) {
  if (orders.length === 0) return null;
  return (
    <section aria-label="Orders waiting for the next price" className="pos">
      <div className="pos-head">
        <h3>Waiting for the next price</h3>
      </div>
      <div className="tbl">
        <table>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id.toString()}>
                <td>
                  {o.isOpen
                    ? `${o.isLong ? 'Long' : 'Short'} ${mwhLabel(o.size)}, limit ${cents(o.limitCents)}`
                    : `Close position ${o.positionId}`}
                </td>
                <td>
                  <button
                    className="mini"
                    disabled={busy}
                    onClick={() => onCancel(o.id)}
                    title="Possible only if no price came within 15 minutes"
                    type="button"
                  >
                    Cancel
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const PICKS = ['1', '10', '50', '100'];

function Ticket({
  perp,
  collateral,
  market,
  indexCents,
  initialSide,
  writer,
  size,
  setSize,
  onPlaced,
}: {
  perp?: Address;
  collateral?: Address;
  market: PerpMarket | null;
  indexCents: number | null;
  initialSide?: Side;
  writer: ReturnType<typeof useContractWriter>;
  size: string;
  setSize: (s: string) => void;
  onPlaced: () => void;
}) {
  const [side, setSide] = useState<Side>('long');
  const [limit, setLimit] = useState('');
  useEffect(() => {
    if (!initialSide) return;
    const t = setTimeout(() => setSide(initialSide), 0);
    return () => clearTimeout(t);
  }, [initialSide]);
  const band = market?.band ?? BAND;
  const feeBps = market?.feeBps ?? 10;
  // a sensible default limit: $2 either side of the price
  const limitCents = priceCents(limit) ?? (indexCents === null ? null : indexCents + (side === 'long' ? 200 : -200));
  const preview = perpTicket({
    side,
    size: sizeUnits(size),
    limitCents,
    indexCents,
    band,
    feeBps,
    freePool: market?.freePool ?? 10n ** 30n,
  });
  const live = Boolean(perp && collateral);
  const n = Number(size);
  const sizeOk = Number.isFinite(n) && n >= 0.1;

  const place = async () => {
    if (!perp || !collateral || preview.problem || limitCents === null) return;
    const units = sizeUnits(size)!;
    if (!(await writer.ensureAllowance(collateral, perp, preview.escrow))) return;
    if (await writer.send(`Placing a ${side}`, { address: perp, abi: perpAbi, functionName: 'requestOpen', args: [side === 'long', units, BigInt(limitCents)] }))
      onPlaced();
  };

  return (
    <aside aria-label="New order" className="ticket">
      <fieldset className="sides" data-side={side} aria-label="Side">
        <span aria-hidden className="thumb" />
        <button aria-pressed={side === 'long'} data-v="long" onClick={() => setSide('long')} type="button">
          Long
        </button>
        <button aria-pressed={side === 'short'} data-v="short" onClick={() => setSide('short')} type="button">
          Short
        </button>
      </fieldset>
      <p className="say">
        {side === 'long'
          ? 'You gain when the Texas price goes up, and lose when it falls.'
          : 'You gain when the Texas price falls, and lose when it goes up.'}
      </p>
      <div className="qty">
        <label className="lab" htmlFor="size">
          How much power
        </label>
        <div className="num">
          <input id="size" inputMode="decimal" onChange={(e) => setSize(e.target.value)} style={{ width: `${Math.max(2, size.length) + 0.4}ch` }} value={size} />
          <span className="u">MWh</span>
        </div>
        <input
          aria-label="Size in MWh"
          max="200"
          min="1"
          onChange={(e) => setSize(e.target.value)}
          type="range"
          value={Math.min(200, Math.max(1, Math.round(n) || 1))}
        />
        <div className="picks">
          {PICKS.map((p) => (
            <button aria-pressed={size === p} key={p} onClick={() => setSize(p)} type="button">
              {p}
            </button>
          ))}
        </div>
      </div>
      <details className="limit">
        <summary>{side === 'long' ? 'Most you pay' : 'Least you sell at'}: {limitCents === null ? '—' : cents(limitCents)}</summary>
        <label className="fld">
          <span>{side === 'long' ? 'Most you pay, per MWh' : 'Least you sell at, per MWh'}</span>
          <span className="in">
            <em className="pre">$</em>
            <input
              inputMode="decimal"
              onChange={(e) => setLimit(e.target.value)}
              placeholder={limitCents === null ? '' : (limitCents / 100).toFixed(2)}
              value={limit}
            />
          </span>
        </label>
      </details>
      <dl className="sum">
        <div>
          <dt>You put in</dt>
          <dd>{sizeOk ? dollars(preview.collateralAtIndex) : '—'}</dd>
        </div>
        <div>
          <dt>Most you can win</dt>
          <dd>{sizeOk ? dollars(preview.maxGainAtIndex) : '—'}</dd>
        </div>
        <div>
          <dt>Most you can lose</dt>
          <dd>{sizeOk ? dollars(preview.collateralAtIndex) : '—'}</dd>
        </div>
        <div>
          <dt>Fee</dt>
          <dd>{sizeOk ? dollars(preview.feeAtIndex) : '—'}</dd>
        </div>
      </dl>
      {live && preview.problem && <p className="fine no">{preview.problem}</p>}
      {writer.error && <p className="fine no">{writer.error}</p>}
      {!live ? (
        <button className={`go${side === 'short' ? ' short' : ''}`} disabled type="button">
          Futures open on testnet soon
        </button>
      ) : writer.account ? (
        <button
          className={`go${side === 'short' ? ' short' : ''}`}
          disabled={Boolean(preview.problem) || Boolean(writer.pending) || market?.paused}
          onClick={() => void place()}
          type="button"
        >
          {writer.pending ?? `Go ${side} ${size} MWh`}
        </button>
      ) : (
        <button className="go neutral" onClick={() => void writer.connect()} type="button">
          Connect wallet
        </button>
      )}
      <p className="fine">
        Fills at the next 5-minute price, never one you can already see. Beyond your limit the order cancels and everything
        comes back. Everything you put in is held in full.
      </p>
    </aside>
  );
}
