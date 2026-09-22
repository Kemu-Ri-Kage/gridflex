'use client';

import { getAddress } from 'viem';

import { SettlementSummary } from '@/components/settlement-panel';
import { TradePanel } from '@/components/trade-panel';
import { addresses } from '@/lib/contracts';
import { useMarkets } from '@/lib/markets';

/**
 * Right column. The order ticket (David's trade-panel.tsx) trades the one
 * market its environment is configured for, so it only appears when that
 * is the selected market - never beside a different market's name.
 */
export function OrderColumn() {
  const { selected } = useMarkets();
  const ticketMarket = addresses.market;
  const showTicket =
    selected !== undefined &&
    ticketMarket !== undefined &&
    getAddress(ticketMarket) === selected.address;

  return (
    <div className="space-y-3">
      <SettlementSummary />
      {showTicket && <TradePanel />}
    </div>
  );
}
