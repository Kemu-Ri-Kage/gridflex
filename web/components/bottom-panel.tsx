'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SettlementPanel } from '@/components/settlement-panel';
import { useWeb3 } from '@/components/web3-provider';
import { formatToken } from '@/lib/format';

function PositionsTab() {
  const { account, snapshot } = useWeb3();

  if (!account) {
    return (
      <p className="p-4 text-xs text-muted-foreground sm:p-6">
        Connect a wallet to see your mUSDT, YES, and NO balances for this market.
      </p>
    );
  }

  const rows = [
    { label: 'mUSDT', value: formatToken(snapshot.collateralBalance) },
    { label: 'YES', value: formatToken(snapshot.yesBalance) },
    { label: 'NO', value: formatToken(snapshot.noBalance) },
  ];

  return (
    <div className="p-4 sm:p-6">
      <div className="grid max-w-sm grid-cols-2 gap-px border border-border bg-border font-mono text-xs">
        {rows.map((row) => (
          <div className="col-span-2 grid grid-cols-2 bg-card px-3 py-2" key={row.label}>
            <span className="text-muted-foreground">{row.label}</span>
            <span className="text-right tabular-nums text-foreground">{row.value}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Wallet balances only — a full position ledger arrives once markets are deployed through{' '}
        <span className="font-mono">MarketFactory</span>.
      </p>
    </div>
  );
}

function HistoryTab() {
  return (
    <p className="p-4 text-xs text-muted-foreground sm:p-6">
      No trade history yet — this market is in demo mode with no{' '}
      <span className="font-mono">BinaryMarket</span> deployed. Once one is live, fills will read
      from its onchain event log, the same way the feed page verifies readings.
    </p>
  );
}

export function BottomPanel() {
  return (
    <Tabs defaultValue="positions">
      <TabsList className="rounded-none border-b border-border bg-transparent px-2" variant="line">
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
        <SettlementPanel />
      </TabsContent>
    </Tabs>
  );
}
