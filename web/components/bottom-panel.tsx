'use client';

import * as React from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SettlementEvidence } from '@/components/settlement-panel';
import { useWeb3 } from '@/components/web3-provider';
import { explorerTxUrl } from '@/lib/explorer';
import {
  formatCentsE18,
  formatSignedPercent,
  formatSignedToken,
  formatToken,
  formatTokenExact,
} from '@/lib/format';
import {
  useBalances,
  useMarkets,
  usePosition,
  useTradeHistory,
} from '@/lib/markets';
import {
  positionRows,
  UNDETERMINED_REASON,
  type PositionRow,
  type UndeterminedReason,
} from '@/lib/position';

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function pnlClass(pnl?: bigint): string {
  if (pnl === undefined || pnl === 0n) return 'text-foreground';
  return pnl > 0n ? 'text-up' : 'text-down';
}

/**
 * The connected wallet's holdings on the selected market. Quantity is the
 * chain balance; average entry comes from the wallet's own trades read from
 * chain (lib/position.ts). Value and P&L are marked at the pool price while
 * the market is open - indicative only, since no mUSDT exit exists before
 * settlement - and at the payout once it settles.
 */
function PositionsTab() {
  const { account } = useWeb3();
  const { selected } = useMarkets();
  const balances = useBalances(account, selected);
  const history = usePosition(account, selected, balances);

  if (!account) {
    return (
      <p className="p-4 text-xs text-muted-foreground sm:p-6">
        Connect a wallet to see positions.
      </p>
    );
  }
  if (!balances || !selected?.live) {
    return (
      <p className="p-4 text-xs text-muted-foreground sm:p-6">
        Reading balances…
      </p>
    );
  }

  const live = selected.live;
  const settled = live.resolved || live.cancelled;
  const loading = history.state === 'loading';
  const rows: PositionRow[] = positionRows(
    { YES: balances.yes, NO: balances.no },
    live,
    history.state === 'ready' ? history.ledger : { undetermined: 'history' },
  );
  const reasons = loading
    ? []
    : [
        ...new Set(
          rows
            .map((row) => row.undetermined)
            .filter((reason): reason is UndeterminedReason => Boolean(reason)),
        ),
      ];

  const columns = [
    { key: 'side', label: 'Side' },
    { key: 'quantity', label: 'Quantity' },
    { key: 'entry', label: 'Avg entry' },
    { key: 'mark', label: settled ? 'Payout' : 'Current price' },
    { key: 'value', label: 'Current value' },
    { key: 'pnl', label: 'Indicative unrealised P&L' },
  ] as const;
  const cells = rows.map((row) => ({
    side: row.side,
    sideClass: row.side === 'YES' ? 'text-up' : 'text-down',
    quantity: formatTokenExact(row.quantity),
    entry: loading
      ? '…'
      : row.averageEntryE18 === undefined
        ? '—'
        : formatCentsE18(row.averageEntryE18),
    mark: formatCentsE18(row.markE18),
    value: `${formatToken(row.value)} mUSDT`,
    pnl: loading
      ? '…'
      : row.pnl === undefined
        ? '—'
        : `${formatSignedToken(row.pnl)} mUSDT` +
          (row.pnlFraction === undefined
            ? ''
            : ` (${formatSignedPercent(row.pnlFraction)})`),
    pnlClass: pnlClass(row.pnl),
  }));

  return (
    <div className="space-y-3 p-4 sm:p-6">
      <div className="font-mono text-xs text-muted-foreground">
        mUSDT balance{' '}
        <span className="text-foreground tabular-nums">
          {formatToken(balances.collateral)}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No YES or NO held on this market.
        </p>
      ) : (
        <>
          {/* Phones: one card per side, every figure visible without scrolling. */}
          <div className="space-y-2 sm:hidden">
            {cells.map((cell) => (
              <dl
                className="grid grid-cols-2 gap-x-3 gap-y-1.5 border border-border bg-card px-3 py-2 font-mono text-xs tabular-nums"
                key={cell.side}
              >
                <dt className={cell.sideClass}>{cell.side}</dt>
                <dd className="text-right text-foreground">{cell.quantity}</dd>
                {columns.slice(2).map((column) => (
                  <React.Fragment key={column.key}>
                    <dt className="text-muted-foreground">{column.label}</dt>
                    <dd
                      className={`text-right ${column.key === 'pnl' ? cell.pnlClass : 'text-foreground'}`}
                    >
                      {cell[column.key]}
                    </dd>
                  </React.Fragment>
                ))}
              </dl>
            ))}
          </div>
          <table className="hidden w-full font-mono text-xs tabular-nums sm:table">
            <thead className="text-left text-muted-foreground">
              <tr>
                {columns.map((column, i) => (
                  <th
                    className={`py-1.5 font-normal ${i === 0 ? 'pr-4' : i === columns.length - 1 ? 'text-right' : 'pr-4 text-right'}`}
                    key={column.key}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border text-foreground">
              {cells.map((cell) => (
                <tr key={cell.side}>
                  <td className={`py-1.5 pr-4 ${cell.sideClass}`}>
                    {cell.side}
                  </td>
                  <td className="py-1.5 pr-4 text-right">{cell.quantity}</td>
                  <td className="py-1.5 pr-4 text-right">{cell.entry}</td>
                  <td className="py-1.5 pr-4 text-right">{cell.mark}</td>
                  <td className="py-1.5 pr-4 text-right">{cell.value}</td>
                  <td className={`py-1.5 text-right ${cell.pnlClass}`}>
                    {cell.pnl}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {rows.length > 0 && (
        <div className="max-w-2xl space-y-1 text-xs leading-5 text-muted-foreground">
          {loading && <p>Reading this wallet&apos;s trades from X Layer…</p>}
          {reasons.map((reason) => (
            <p key={reason}>
              Average entry unavailable, so only current value is shown:{' '}
              {UNDETERMINED_REASON[reason]}
            </p>
          ))}
          <p>
            {settled
              ? 'Marked at the settlement payout. Redeem in the order ticket to collect it.'
              : 'Indicative: marked at the pool price. There is no exit into mUSDT before settlement, so this value is only realised by holding to settlement and redeeming.'}
          </p>
        </div>
      )}
    </div>
  );
}

function HistoryTab() {
  const { selected } = useMarkets();
  const history = useTradeHistory(selected);

  if (history.state !== 'ready') {
    const message = {
      loading: 'Loading trades…',
      'too-long': 'Trade history is too long to read here.',
      error: 'Could not read trades from X Layer.',
    }[history.state];
    return (
      <p className="p-4 text-xs text-muted-foreground sm:p-6">{message}</p>
    );
  }

  if (history.trades.length === 0) {
    return (
      <p className="p-4 text-xs text-muted-foreground sm:p-6">No trades yet.</p>
    );
  }

  return (
    <div className="overflow-x-auto p-4 sm:p-6">
      <table className="w-full min-w-[520px] font-mono text-xs tabular-nums">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1.5 pr-4 font-normal">Block</th>
            <th className="py-1.5 pr-4 font-normal">Trade</th>
            <th className="py-1.5 pr-4 text-right font-normal">In</th>
            <th className="py-1.5 pr-4 text-right font-normal">Out</th>
            <th className="py-1.5 pr-4 font-normal">Account</th>
            <th className="py-1.5 font-normal">Tx</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border text-foreground">
          {history.trades.map((trade) => (
            <tr key={`${trade.txHash}:${trade.amountIn}`}>
              <td className="py-1.5 pr-4">{trade.blockNumber.toString()}</td>
              <td className="py-1.5 pr-4">
                {/* yesForNo: YES paid in, NO received. As the second leg
                    of a buy that is a NO buy; otherwise a switch. */}
                {trade.buyLeg
                  ? trade.yesForNo
                    ? 'Buy NO'
                    : 'Buy YES'
                  : trade.yesForNo
                    ? 'Switch YES → NO'
                    : 'Switch NO → YES'}
              </td>
              <td className="py-1.5 pr-4 text-right">
                {formatToken(trade.amountIn)}
              </td>
              <td className="py-1.5 pr-4 text-right">
                {formatToken(trade.amountOut)}
              </td>
              <td className="py-1.5 pr-4 text-muted-foreground">
                {shortAddress(trade.account)}
              </td>
              <td className="py-1.5">
                <a
                  className="text-chart-1 hover:underline"
                  href={explorerTxUrl(trade.txHash)}
                  rel="noreferrer"
                  target="_blank"
                >
                  {shortAddress(trade.txHash)}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BottomPanel() {
  return (
    <Tabs defaultValue="positions">
      <TabsList
        className="rounded-none border-b border-border bg-transparent px-2"
        variant="line"
      >
        <TabsTrigger value="positions">Positions</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
        <TabsTrigger value="settlement">Settlement</TabsTrigger>
      </TabsList>
      <TabsContent value="positions">
        <PositionsTab />
      </TabsContent>
      <TabsContent value="history">
        <HistoryTab />
      </TabsContent>
      <TabsContent value="settlement">
        <SettlementEvidence />
      </TabsContent>
    </Tabs>
  );
}
