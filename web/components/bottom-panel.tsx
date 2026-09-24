'use client';

import * as React from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SettlementEvidence } from '@/components/settlement-panel';
import { useWeb3 } from '@/components/web3-provider';
import { explorerTxUrl } from '@/lib/explorer';
import {
  formatCentsE18,
  formatBlockTime,
  formatSignedPercent,
  formatSignedToken,
  formatToken,
  formatTokenExact,
  signedTokenDirection,
} from '@/lib/format';
import {
  useBalances,
  useMarkets,
  usePosition,
  useTradeHistory,
  type WalletAction,
} from '@/lib/markets';
import {
  positionRows,
  UNDETERMINED_REASON,
  type PositionRow,
  type UndeterminedReason,
} from '@/lib/position';
import { losingSide } from '@/lib/redeemable';

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Green and red only for a P&L whose shown digits are a gain or a loss. */
function pnlClass(pnl?: bigint): string {
  if (pnl === undefined) return 'text-foreground';
  return {
    up: 'text-up',
    down: 'text-down',
    flat: 'text-foreground',
  }[signedTokenDirection(pnl)];
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
  // Once resolved, the losing side pays nothing and redeem() leaves it in
  // the wallet: not a position, so not listed.
  const lost = losingSide(live);
  const rows: PositionRow[] = positionRows(
    { YES: balances.yes, NO: balances.no },
    live,
    history.state === 'ready' ? history.ledger : { undetermined: 'history' },
  ).filter((row) => row.side !== lost);
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
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {lost && balances[lost === 'YES' ? 'yes' : 'no'] > 0n
            ? 'Nothing left to redeem on this market.'
            : 'No YES or NO held on this market.'}
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
              : 'Indicative: marked at the pool price.'}
          </p>
        </div>
      )}
    </div>
  );
}

const MAX_UINT256 = 2n ** 256n - 1n;

/** What a wallet action did, in the words and amounts History shows. */
function describeAction(action: WalletAction): {
  label: string;
  amount: string;
} {
  switch (action.kind) {
    case 'approve':
      return {
        label: `Approve ${action.token}`,
        amount:
          action.amount === MAX_UINT256
            ? `Unlimited ${action.token}`
            : `${formatToken(action.amount)} ${action.token}`,
      };
    case 'mint':
      return {
        label: 'Mint YES + NO',
        amount: `${formatToken(action.amount)} mUSDT → ${formatToken(action.amount)} YES + ${formatToken(action.amount)} NO`,
      };
    case 'swap': {
      // yesForNo: YES paid in, NO received. As the second leg of a buy
      // that is a NO buy; otherwise a switch.
      const paid = action.yesForNo ? 'YES' : 'NO';
      const got = action.yesForNo ? 'NO' : 'YES';
      return {
        label: action.buyLeg ? `Swap (Buy ${got})` : `Switch ${paid} → ${got}`,
        amount: `${formatToken(action.amountIn)} ${paid} → ${formatToken(action.amountOut)} ${got}`,
      };
    }
    case 'redeem':
      return {
        label: 'Redeem',
        amount: `${formatToken(action.yesBurned)} YES + ${formatToken(action.noBurned)} NO → ${formatToken(action.payout)} mUSDT`,
      };
  }
}

function blockCount(block: bigint): string {
  return block.toLocaleString('en-US');
}

/**
 * The connected wallet's own transactions on the selected market, read
 * from chain by lib/markets.tsx's wallet scan. The search never goes back
 * past the market's creation block, which is shown as its floor.
 */
function HistoryTab() {
  const { account } = useWeb3();
  const { selected } = useMarkets();
  const history = useTradeHistory(account, selected);

  if (!account) {
    return (
      <p className="p-4 text-xs text-muted-foreground sm:p-6">
        Connect a wallet to see its trades on this market.
      </p>
    );
  }
  if (history.state !== 'ready') {
    const message = {
      loading: "Reading this wallet's trades from X Layer…",
      error: 'Could not read trades from X Layer.',
    }[history.state];
    return (
      <p className="p-4 text-xs text-muted-foreground sm:p-6">{message}</p>
    );
  }

  const rows = history.trades.map((trade) => ({
    ...trade,
    ...describeAction(trade.action),
    key: `${trade.txHash}:${trade.action.kind}:${'token' in trade.action ? trade.action.token : ''}`,
    time: formatBlockTime(trade.timestamp),
  }));
  const txLink = (txHash: string) => (
    <a
      className="text-chart-1 hover:underline"
      href={explorerTxUrl(txHash)}
      rel="noreferrer"
      target="_blank"
    >
      {shortAddress(txHash)}
    </a>
  );

  return (
    <div className="space-y-3 p-4 sm:p-6">
      {!history.complete && (
        <p className="max-w-2xl border border-border bg-card px-3 py-2 text-xs leading-5 text-foreground">
          Partial list: this wallet has more activity on this market than can be
          searched from the browser in one pass. Showing the{' '}
          {rows.length === 1 ? 'transaction' : `${rows.length} transactions`}{' '}
          found; others may be missing.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {history.complete
            ? 'No trades by this wallet on this market.'
            : 'No trades found yet.'}
        </p>
      ) : (
        <>
          {/* Phones: one card per transaction, nothing to scroll sideways. */}
          <ul className="space-y-2 sm:hidden">
            {rows.map((row) => (
              <li
                className="space-y-1 border border-border bg-card px-3 py-2 font-mono text-xs tabular-nums"
                key={row.key}
              >
                <div className="flex justify-between gap-3">
                  <span className="text-foreground">{row.label}</span>
                  {txLink(row.txHash)}
                </div>
                <div className="text-foreground">{row.amount}</div>
                <div className="text-muted-foreground">{row.time}</div>
              </li>
            ))}
          </ul>
          <table className="hidden w-full font-mono text-xs tabular-nums sm:table">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-4 font-normal">Time</th>
                <th className="py-1.5 pr-4 font-normal">Action</th>
                <th className="py-1.5 pr-4 font-normal">Amount</th>
                <th className="py-1.5 pr-4 text-right font-normal">Block</th>
                <th className="py-1.5 font-normal">Tx</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border text-foreground">
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className="py-1.5 pr-4 whitespace-nowrap text-muted-foreground">
                    {row.time}
                  </td>
                  <td className="py-1.5 pr-4 whitespace-nowrap">{row.label}</td>
                  <td className="py-1.5 pr-4">{row.amount}</td>
                  <td className="py-1.5 pr-4 text-right">
                    {blockCount(row.blockNumber)}
                  </td>
                  <td className="py-1.5">{txLink(row.txHash)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
        Searched from block {blockCount(history.fromBlock)}, where this market
        was created, to {blockCount(history.toBlock)}. Failed transactions
        aren&apos;t listed.
      </p>
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
