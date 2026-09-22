'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SettlementEvidence } from '@/components/settlement-panel';
import { useWeb3 } from '@/components/web3-provider';
import { explorerTxUrl } from '@/lib/explorer';
import { formatToken } from '@/lib/format';
import { useBalances, useMarkets, useTradeHistory } from '@/lib/markets';

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function PositionsTab() {
  const { account } = useWeb3();
  const { selected } = useMarkets();
  const balances = useBalances(account, selected);

  if (!account) {
    return (
      <p className="p-4 text-xs text-muted-foreground sm:p-6">
        Connect a wallet to see balances.
      </p>
    );
  }

  const rows = [
    { label: 'mUSDT', value: balances?.collateral },
    { label: 'YES', value: balances?.yes },
    { label: 'NO', value: balances?.no },
  ];

  return (
    <div className="p-4 sm:p-6">
      <div className="grid max-w-sm grid-cols-2 gap-px border border-border bg-border font-mono text-xs">
        {rows.map((row) => (
          <div
            className="col-span-2 grid grid-cols-2 bg-card px-3 py-2"
            key={row.label}
          >
            <span className="text-muted-foreground">{row.label}</span>
            <span className="text-right tabular-nums text-foreground">
              {row.value === undefined ? '…' : formatToken(row.value)}
            </span>
          </div>
        ))}
      </div>
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
            <th className="py-1.5 pr-4 font-normal">Swap</th>
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
                {trade.yesForNo ? 'YES → NO' : 'NO → YES'}
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
