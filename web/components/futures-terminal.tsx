'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';

import { DerivativesComingSoon } from '@/components/derivatives-coming-soon';
import {
  CHIP_BUTTON,
  ctaClass,
  QUIET_BUTTON,
  Segmented,
  Stat,
} from '@/components/terminal-ui';
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
import {
  dollars,
  mwhLabel,
  perpTicket,
  positionAt,
  priceCents,
  sizeUnits,
  type Side,
} from '@/lib/perp-view';
import { cn } from '@/lib/utils';

const POLL_MS = 15_000;
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function FuturesTerminal() {
  const { perp, feed, collateral } = deployed;
  if (!perp || !feed || !collateral) {
    return (
      <DerivativesComingSoon
        code="TXPOWER-PERP · perpetual future"
        name="Texas power, long or short"
        lines={[
          'Go long or short on the live ERCOT North Hub price in MWh, with no expiry: close whenever you like.',
          'Fully backed, no leverage, no liquidation: you post your largest possible loss inside the price band, and the pool sets aside your largest possible gain.',
          'Orders fill at the next 5-minute price, never at one you could already see.',
          'The bigger side pays a small hourly funding to the pool; 0.10% to open and to close.',
        ]}
        facts={[
          { label: 'Price band', value: '−$50 to $300 /MWh' },
          { label: 'Size', value: 'from 0.1 MWh' },
          { label: 'Fill', value: 'next 5-min price' },
          { label: 'Expiry', value: 'none' },
        ]}
      />
    );
  }
  return <LiveFutures collateral={collateral} feed={feed} perp={perp} />;
}

function LiveFutures({
  perp,
  feed,
  collateral,
}: {
  perp: Address;
  feed: Address;
  collateral: Address;
}) {
  const writer = useContractWriter();
  const [market, setMarket] = useState<PerpMarket | null>(null);
  const [mine, setMine] = useState<{
    positions: MyPosition[];
    orders: MyOrder[];
  }>({ positions: [], orders: [] });
  const [readError, setReadError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setMarket(await readPerpMarket(perp, feed));
      if (writer.account) setMine(await readMyPerp(perp, writer.account));
      setReadError(undefined);
    } catch {
      setReadError('Could not read the market from X Layer; retrying.');
    }
  }, [perp, feed, writer.account]);

  useEffect(() => {
    // the first read starts from a timer too, so the effect itself sets no state
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  return (
    <div className="grid flex-1 gap-px bg-border lg:grid-cols-[minmax(0,1fr)_384px]">
      <div className="flex flex-col gap-6 bg-background p-4 sm:p-6">
        <MarketStrip market={market} />
        {readError && <p className="text-xs text-warning">{readError}</p>}
        <Positions
          busy={Boolean(writer.pending)}
          market={market}
          onClose={async (id) => {
            if (
              await writer.send('Asking to close', {
                address: perp,
                abi: perpAbi,
                functionName: 'requestClose',
                args: [id],
              })
            )
              void refresh();
          }}
          positions={mine.positions}
        />
        <Orders
          busy={Boolean(writer.pending)}
          onCancel={async (id) => {
            if (
              await writer.send('Cancelling', {
                address: perp,
                abi: perpAbi,
                functionName: 'cancelOrder',
                args: [id],
              })
            )
              void refresh();
          }}
          orders={mine.orders}
        />
      </div>
      <div className="bg-background p-4 sm:p-6">
        <Ticket
          collateral={collateral}
          market={market}
          onPlaced={() => void refresh()}
          perp={perp}
          writer={writer}
        />
      </div>
    </div>
  );
}

function MarketStrip({ market }: { market: PerpMarket | null }) {
  const oi = market
    ? `${mwhLabel(market.longSize)} / ${mwhLabel(market.shortSize)}`
    : '—';
  return (
    <div>
      <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        TXPOWER-PERP · perpetual future{' '}
        {market?.paused && (
          <span className="ml-2 text-warning">· opening paused</span>
        )}
      </div>
      <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
        Texas power, long or short
      </h1>
      <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="15-min index" size="lg">
          {market?.indexCents == null ? '—' : usd(market.indexCents)}
        </Stat>
        <Stat label="Band">
          {market
            ? `${usd(market.band.floorCents)} – ${usd(market.band.capCents)}`
            : '—'}
        </Stat>
        <Stat label="Pool free">{market ? dollars(market.freePool) : '—'}</Stat>
        <Stat label="Long / short">{oi}</Stat>
        <Stat label="Funding /MWh/h">
          {market
            ? `${market.fundingCentsPerMwhHour >= 0 ? 'longs' : 'shorts'} ${Math.abs(market.fundingCentsPerMwhHour).toFixed(3)}¢`
            : '—'}
        </Stat>
        <Stat label="Fee">
          {market ? `${(market.feeBps / 100).toFixed(2)}%` : '—'}
        </Stat>
      </div>
      {market && market.indexCents === null && (
        <p className="mt-3 text-xs text-warning">
          No index right now (a missed 5-minute price): new orders wait for
          three back-to-back prices.
        </p>
      )}
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
    <section>
      <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        Your positions
      </h2>
      {positions.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No open positions.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm tabular-nums">
            <thead className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="py-2 font-normal">Side</th>
                <th className="py-2 font-normal">Size</th>
                <th className="py-2 font-normal">Entry</th>
                <th className="py-2 font-normal">Gain / loss</th>
                <th className="py-2 font-normal">Funding</th>
                <th className="py-2 font-normal">If closed now</th>
                <th className="py-2">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const at =
                  market?.indexCents == null
                    ? null
                    : positionAt(
                        p,
                        market.indexCents,
                        market.band,
                        market.feeBps,
                      );
                return (
                  <tr className="border-t border-border" key={p.id.toString()}>
                    <td
                      className={cn('py-2', p.isLong ? 'text-up' : 'text-down')}
                    >
                      {p.isLong ? 'Long' : 'Short'}
                    </td>
                    <td className="py-2">{mwhLabel(p.size)}</td>
                    <td className="py-2">{usd(p.entryPriceCents)}</td>
                    <td
                      className={cn(
                        'py-2',
                        at &&
                          (at.pnl > 0n
                            ? 'text-up'
                            : at.pnl < 0n
                              ? 'text-down'
                              : ''),
                      )}
                    >
                      {at ? dollars(at.pnl) : '—'}
                    </td>
                    <td className="py-2">{dollars(-p.fundingOwed)}</td>
                    <td className="py-2">
                      {at
                        ? dollars(
                            at.payout > p.fundingOwed
                              ? at.payout - p.fundingOwed
                              : 0n,
                          )
                        : '—'}
                    </td>
                    <td className="py-2 text-right">
                      {p.closePending ? (
                        <span className="text-xs text-muted-foreground">
                          Closing at the next price
                        </span>
                      ) : (
                        <button
                          className={QUIET_BUTTON}
                          disabled={busy}
                          onClick={() => onClose(p.id)}
                          type="button"
                        >
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
      )}
    </section>
  );
}

function Orders({
  orders,
  busy,
  onCancel,
}: {
  orders: MyOrder[];
  busy: boolean;
  onCancel: (id: bigint) => void;
}) {
  if (orders.length === 0) return null;
  return (
    <section>
      <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        Waiting for the next price
      </h2>
      <ul className="mt-3 space-y-2 text-sm">
        {orders.map((o) => (
          <li
            className="flex items-center justify-between gap-3 border-t border-border pt-2"
            key={o.id.toString()}
          >
            <span className="tabular-nums">
              {o.isOpen
                ? `${o.isLong ? 'Long' : 'Short'} ${mwhLabel(o.size)}, limit ${usd(o.limitCents)}`
                : `Close position ${o.positionId}`}
            </span>
            <button
              className={QUIET_BUTTON}
              disabled={busy}
              onClick={() => onCancel(o.id)}
              title="Possible only if no price came within 15 minutes"
              type="button"
            >
              Cancel
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Ticket({
  perp,
  collateral,
  market,
  writer,
  onPlaced,
}: {
  perp: Address;
  collateral: Address;
  market: PerpMarket | null;
  writer: ReturnType<typeof useContractWriter>;
  onPlaced: () => void;
}) {
  const [side, setSide] = useState<Side>('long');
  const [size, setSize] = useState('1');
  const [limit, setLimit] = useState('');
  const index = market?.indexCents ?? null;
  // a sensible default limit: $2 either side of the index
  const limitCents =
    priceCents(limit) ??
    (index === null ? null : index + (side === 'long' ? 200 : -200));
  const preview = market
    ? perpTicket({
        side,
        size: sizeUnits(size),
        limitCents,
        indexCents: index,
        band: market.band,
        feeBps: market.feeBps,
        freePool: market.freePool,
      })
    : null;

  const place = async () => {
    if (!preview || preview.problem || limitCents === null) return;
    const units = sizeUnits(size)!;
    if (!(await writer.ensureAllowance(collateral, perp, preview.escrow)))
      return;
    const ok = await writer.send(`Placing a ${side}`, {
      address: perp,
      abi: perpAbi,
      functionName: 'requestOpen',
      args: [side === 'long', units, BigInt(limitCents)],
    });
    if (ok) onPlaced();
  };

  return (
    <div className="flex flex-col gap-4">
      <Segmented
        label="Side"
        onChange={setSide}
        options={[
          { id: 'long', label: 'Long' },
          { id: 'short', label: 'Short' },
        ]}
        value={side}
      />
      <label className="block">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Size (MWh)
        </span>
        <input
          className="mt-1.5 h-11 w-full min-w-0 rounded-[2px] border border-border bg-transparent px-3 font-mono text-base tabular-nums text-foreground outline-none focus:border-foreground/60"
          inputMode="decimal"
          onChange={(e) => setSize(e.target.value)}
          value={size}
        />
        <span className="mt-2 flex gap-2">
          {['1', '10', '100'].map((preset) => (
            <button
              aria-pressed={size === preset}
              className={CHIP_BUTTON}
              key={preset}
              onClick={() => setSize(preset)}
              type="button"
            >
              {preset}
            </button>
          ))}
        </span>
      </label>
      <label className="block">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          {side === 'long'
            ? 'Most you pay ($/MWh)'
            : 'Least you sell at ($/MWh)'}
        </span>
        <input
          className="mt-1.5 h-11 w-full min-w-0 rounded-[2px] border border-border bg-transparent px-3 font-mono text-base tabular-nums text-foreground outline-none focus:border-foreground/60"
          inputMode="decimal"
          onChange={(e) => setLimit(e.target.value)}
          placeholder={limitCents === null ? '' : (limitCents / 100).toFixed(2)}
          value={limit}
        />
      </label>
      {preview && (
        <dl className="space-y-1.5 border-t border-border pt-3 text-xs tabular-nums">
          <Row
            label="Held now (refund after the fill)"
            value={dollars(preview.escrow)}
          />
          <Row
            label="Collateral at the index"
            value={dollars(preview.collateralAtIndex)}
          />
          <Row
            label="Largest gain at the index"
            value={dollars(preview.maxGainAtIndex)}
          />
          <Row label="Fee to open" value={dollars(preview.feeAtIndex)} />
        </dl>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        Fills at the next 5-minute price, never at one you can already see. If
        that price is beyond your limit, the order cancels and everything comes
        back.
      </p>
      {preview?.problem && (
        <p className="text-xs text-warning">{preview.problem}</p>
      )}
      {writer.error && <p className="text-xs text-down">{writer.error}</p>}
      {writer.account ? (
        <button
          className={ctaClass(side === 'long' ? 'up' : 'down')}
          disabled={
            !preview ||
            Boolean(preview.problem) ||
            Boolean(writer.pending) ||
            market?.paused
          }
          onClick={() => void place()}
          type="button"
        >
          {writer.pending ?? `Place ${side} order`}
        </button>
      ) : (
        <button
          className={ctaClass()}
          onClick={() => void writer.connect()}
          type="button"
        >
          Connect wallet
        </button>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}
