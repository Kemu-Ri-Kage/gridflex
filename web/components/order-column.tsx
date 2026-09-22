'use client';

import * as React from 'react';

import { SettlementSummary } from '@/components/settlement-panel';
import { TradePanel } from '@/components/trade-panel';
import { useWeb3 } from '@/components/web3-provider';
import { useMarkets } from '@/lib/markets';

/**
 * Right column. The order ticket follows the market selected in the list:
 * the selection is handed to the Web3Provider, which reads from and sends
 * transactions to that contract alone, so the ticket never trades a market
 * other than the one named above it.
 */
export function OrderColumn() {
  const { selected } = useMarkets();
  const { selectMarket } = useWeb3();
  const address = selected?.address;

  React.useEffect(() => {
    selectMarket(address);
    return () => selectMarket(undefined);
  }, [address, selectMarket]);

  return (
    <div className="space-y-3">
      <SettlementSummary />
      {selected && <TradePanel />}
    </div>
  );
}
