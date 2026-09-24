'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import type { Address } from 'viem';

import { Button } from '@/components/ui/button';
import { useWeb3 } from '@/components/web3-provider';
import { formatToken, formatTokenExact } from '@/lib/format';
import {
  marketName,
  statusLabel,
  useHoldings,
  useMarkets,
  type HoldingsRead,
  type Market,
} from '@/lib/markets';
import {
  openPortfolio,
  portfolioRows,
  portfolioTotals,
  redeemableMarkets,
  redeemAmount,
  redeemEach,
  winningsLine,
  type PortfolioRow,
  type RedeemStatus,
} from '@/lib/portfolio';

interface PortfolioValue extends HoldingsRead {
  /** This wallet's redeems from the Portfolio tab this session, by market. */
  statuses: Readonly<Record<string, RedeemStatus>>;
  /** A redeem started here is still going. */
  redeeming: boolean;
  /** Redeem on each market in turn, one wallet prompt each. */
  redeem: (addresses: readonly string[]) => Promise<void>;
}

const PortfolioContext = React.createContext<PortfolioValue | null>(null);

const NO_STATUSES: Readonly<Record<string, RedeemStatus>> = {};

/**
 * One read of the wallet's holdings on every listed market, shared by the
 * winnings banner and the Portfolio tab, and the redeems started from the
 * tab, kept here so they carry on and stay listed if the tab is switched.
 */
export function PortfolioProvider({ children }: { children: React.ReactNode }) {
  const { account, pendingAction, redeemMarket } = useWeb3();
  // pendingAction clears when a transaction finishes, so balances are
  // re-read then as well as on the markets poll.
  const read = useHoldings(account, pendingAction ?? '');
  const [redeems, setRedeems] = React.useState<{
    account?: Address;
    statuses: Record<string, RedeemStatus>;
  }>({ statuses: {} });
  const [redeeming, setRedeeming] = React.useState(false);

  const redeem = React.useCallback(
    async (addresses: readonly string[]) => {
      if (!account) return;
      setRedeeming(true);
      await redeemEach(
        addresses as readonly Address[],
        redeemMarket,
        (address, status) =>
          setRedeems((previous) => ({
            account,
            statuses: {
              ...(previous.account === account ? previous.statuses : {}),
              [address]: status,
            },
          })),
      );
      // redeemEach never rejects: every failure is a row status.
      setRedeeming(false);
    },
    [account, redeemMarket],
  );

  const statuses =
    account && redeems.account === account ? redeems.statuses : NO_STATUSES;
  const value = React.useMemo<PortfolioValue>(
    () => ({ ...read, statuses, redeeming, redeem }),
    [read, statuses, redeeming, redeem],
  );

  return (
    <PortfolioContext.Provider value={value}>
      {children}
    </PortfolioContext.Provider>
  );
}

function usePortfolio(): PortfolioValue {
  const value = React.useContext(PortfolioContext);
  if (!value)
    throw new Error('usePortfolio must be used within PortfolioProvider.');
  return value;
}

/** The wallet's rows across every market; undefined until both reads land. */
function usePortfolioRows(): PortfolioRow[] | undefined {
  const { markets } = useMarkets();
  const { holdings, statuses } = usePortfolio();
  return React.useMemo(
    () =>
      markets && holdings
        ? portfolioRows(markets, holdings, new Set(Object.keys(statuses)))
        : undefined,
    [markets, holdings, statuses],
  );
}

const DISMISSED_KEY = 'gridflex:winnings-dismissed';

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Below the instrument bar whenever redeem() would pay this wallet on any
 * listed market, not only the selected one. Dismissed for the session.
 */
export function WinningsBanner() {
  const { account } = useWeb3();
  const rows = usePortfolioRows();
  const [dismissed, setDismissed] = React.useState(readDismissed);
  const line = rows && winningsLine(portfolioTotals(rows));

  if (!account || !line || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.sessionStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Private window or blocked storage: dismissed until the page reloads.
    }
  };

  return (
    <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2 text-xs sm:px-6">
      <p className="min-w-0 flex-1 leading-5 text-foreground">
        {line} ·{' '}
        <button
          className="text-chart-1 hover:underline"
          onClick={openPortfolio}
          type="button"
        >
          View portfolio
        </button>
      </p>
      <Button
        aria-label="Dismiss"
        className="shrink-0 rounded-[2px] text-muted-foreground shadow-none"
        onClick={dismiss}
        size="icon-xs"
        variant="ghost"
      >
        <X />
      </Button>
    </div>
  );
}

const STATUS_WORDS: Record<RedeemStatus, string> = {
  waiting: 'Waiting…',
  redeeming: 'Redeeming…',
  redeemed: 'Redeemed',
  failed: 'Failed',
};

function quantity(value: bigint): string {
  return value === 0n ? '—' : formatTokenExact(value);
}

/** "12.34 mUSDT", starred when marked at a pool price (footnoted below). */
function valueText(row: { value?: bigint; basis?: string }): string {
  if (row.value === undefined) return '—';
  return `${formatToken(row.value)} mUSDT${row.basis === 'indicative' ? '*' : ''}`;
}

/**
 * The connected wallet's YES and NO on every listed market, with what each
 * is worth and what redeem() would pay now. Clicking a question selects
 * that market; Redeem and Redeem all send one wallet prompt per market.
 */
export function PortfolioTab() {
  const { account, pendingAction, error: walletError } = useWeb3();
  const { markets, select, now, error: marketsError } = useMarkets();
  const { holdings, error, statuses, redeeming, redeem } = usePortfolio();
  const rows = usePortfolioRows();

  if (!account) {
    return (
      <p className="p-4 text-xs text-muted-foreground sm:p-6">
        Connect a wallet to see its positions on every market.
      </p>
    );
  }
  if (!rows) {
    return (
      <p className="p-4 text-xs text-muted-foreground sm:p-6">
        {error && !holdings
          ? 'Could not read balances from X Layer.'
          : (!markets && marketsError) || 'Reading balances…'}
      </p>
    );
  }

  const byAddress = new Map<string, Market>(
    markets?.map((market) => [market.address, market]),
  );
  const totals = portfolioTotals(rows);
  // A market just redeemed may still show a balance until the re-read lands.
  const toRedeem = redeemableMarkets(rows).filter(
    (address) => statuses[address] !== 'redeemed',
  );
  const busy = redeeming || pendingAction !== undefined;
  const failed = Object.values(statuses).includes('failed');
  const totalValue = valueText({
    value: totals.value,
    basis: totals.indicative ? 'indicative' : 'payout',
  });

  const cells = rows.map((row) => {
    const market = byAddress.get(row.address);
    const status = statuses[row.address];
    return {
      row,
      question: market ? marketName(market) : row.address,
      marketStatus: (market && statusLabel(market, now)) ?? '—',
      yes: quantity(row.yes),
      no: quantity(row.no),
      value: valueText(row),
      redeemable:
        row.redeemable > 0n ? `${redeemAmount(row.redeemable)} mUSDT` : '—',
      // A redeem confirmed or queued shows its status, even before the
      // balances are re-read; a failed one can be retried.
      action:
        status && status !== 'failed' ? (
          <span className="text-muted-foreground">{STATUS_WORDS[status]}</span>
        ) : row.redeemable > 0n ? (
          <Button
            className="h-6 rounded-[2px] px-2 shadow-none"
            disabled={busy}
            onClick={() => void redeem([row.address])}
            size="xs"
            variant="outline"
          >
            {status === 'failed' ? 'Retry' : 'Redeem'}
          </Button>
        ) : status ? (
          <span className="text-down">{STATUS_WORDS[status]}</span>
        ) : null,
    };
  });
  const questionButton = (address: string, question: string) => (
    <button
      className="text-left text-foreground hover:underline"
      onClick={() => select(address as Address)}
      type="button"
    >
      {question}
    </button>
  );

  return (
    <div className="space-y-3 p-4 sm:p-6">
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No YES or NO held on any market.
        </p>
      ) : (
        <>
          {toRedeem.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 border border-border bg-card px-3 py-2 text-xs">
              <span className="text-foreground">
                {winningsLine(totals)}.
              </span>
              <Button
                className="rounded-[2px] shadow-none"
                disabled={busy}
                onClick={() => void redeem(toRedeem)}
                size="sm"
                variant="outline"
              >
                Redeem all
              </Button>
            </div>
          )}

          {/* Phones: one card per market, every figure visible without scrolling. */}
          <div className="space-y-2 sm:hidden">
            {cells.map((cell) => (
              <div
                className="space-y-1.5 border border-border bg-card px-3 py-2 text-xs"
                key={cell.row.address}
              >
                {questionButton(cell.row.address, cell.question)}
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono tabular-nums">
                <dt className="text-muted-foreground">Status</dt>
                <dd className="text-right text-foreground">{cell.marketStatus}</dd>
                <dt className="text-up">YES</dt>
                <dd className="text-right text-foreground">{cell.yes}</dd>
                <dt className="text-down">NO</dt>
                <dd className="text-right text-foreground">{cell.no}</dd>
                <dt className="text-muted-foreground">Value</dt>
                <dd className="text-right text-foreground">{cell.value}</dd>
                <dt className="text-muted-foreground">Redeemable</dt>
                <dd className="text-right text-foreground">{cell.redeemable}</dd>
                </dl>
                {cell.action && <div className="text-right">{cell.action}</div>}
              </div>
            ))}
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 border border-border px-3 py-2 font-mono text-xs tabular-nums">
              <dt className="text-muted-foreground">Total value</dt>
              <dd className="text-right text-foreground">{totalValue}</dd>
              <dt className="text-muted-foreground">Total redeemable</dt>
              <dd className="text-right text-foreground">
                {totals.redeemable > 0n
                  ? `${redeemAmount(totals.redeemable)} mUSDT`
                  : '—'}
              </dd>
            </dl>
          </div>

          <table className="hidden w-full font-mono text-xs tabular-nums sm:table">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-4 font-normal">Market</th>
                <th className="py-1.5 pr-4 font-normal">Status</th>
                <th className="py-1.5 pr-4 text-right font-normal">YES</th>
                <th className="py-1.5 pr-4 text-right font-normal">NO</th>
                <th className="py-1.5 pr-4 text-right font-normal">Value</th>
                <th className="py-1.5 pr-4 text-right font-normal">Redeemable</th>
                <th className="py-1.5 font-normal">
                  <span className="sr-only">Redeem</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border text-foreground">
              {cells.map((cell) => (
                <tr key={cell.row.address}>
                  <td className="py-1.5 pr-4 font-sans">
                    {questionButton(cell.row.address, cell.question)}
                  </td>
                  <td className="py-1.5 pr-4 whitespace-nowrap">
                    {cell.marketStatus}
                  </td>
                  <td className="py-1.5 pr-4 text-right">{cell.yes}</td>
                  <td className="py-1.5 pr-4 text-right">{cell.no}</td>
                  <td className="py-1.5 pr-4 text-right whitespace-nowrap">
                    {cell.value}
                  </td>
                  <td className="py-1.5 pr-4 text-right whitespace-nowrap">
                    {cell.redeemable}
                  </td>
                  <td className="py-1.5 text-right whitespace-nowrap">
                    {cell.action}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-border text-foreground">
              <tr>
                <td className="py-1.5 pr-4 text-muted-foreground" colSpan={4}>
                  Total
                </td>
                <td className="py-1.5 pr-4 text-right whitespace-nowrap">
                  {totalValue}
                </td>
                <td className="py-1.5 pr-4 text-right whitespace-nowrap">
                  {totals.redeemable > 0n
                    ? `${redeemAmount(totals.redeemable)} mUSDT`
                    : '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </>
      )}

      <div className="max-w-2xl space-y-1 text-xs leading-5 text-muted-foreground">
        {failed && walletError && <p className="text-down">{walletError}</p>}
        {error && holdings && (
          <p>Could not refresh balances from X Layer; showing the last read.</p>
        )}
        {totals.indicative && (
          <p>
            * Indicative: marked at the pool price, with no mUSDT exit before
            settlement.
          </p>
        )}
        {rows.length > 0 && (
          <p>
            A settled market shows its payout: 1 mUSDT per winning token, 0.5
            per token if cancelled.
          </p>
        )}
      </div>
    </div>
  );
}
