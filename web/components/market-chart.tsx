'use client';

import * as React from 'react';

import { CandlestickChart } from '@/components/candlestick-chart';
import {
  SETTLEMENT_RANGES,
  SettlementPriceChart,
  type PresetRequest,
  type SettlementRange,
} from '@/components/settlement-price-chart';
import { Segmented } from '@/components/terminal-ui';
import { chartStrikeDollars, useMarkets } from '@/lib/markets';

type View = 'settlement' | 'live';

const VIEWS: readonly { id: View; label: string }[] = [
  { id: 'settlement', label: 'Settlement price' },
  { id: 'live', label: 'Live price' },
];

/**
 * The centre chart, in two views (design-brief.md §9). Settlement price,
 * the default: the verified daily price markets settle on, with every
 * listed strike. Live price: real-time candles for reference, with the
 * selected market's strike line. The live view fades up per market (the
 * swap in design-brief.md §13); the settlement view shows every strike, so
 * it stays mounted across a change of market and keeps the viewer's zoom.
 */
export function MarketChart() {
  const { selected } = useMarkets();
  const [view, setView] = React.useState<View>('settlement');
  // The preset the settlement view shows, or null once the viewer has
  // zoomed or panned off it; `request` re-applies a preset on every click.
  const [range, setRange] = React.useState<SettlementRange | null>('90d');
  const [request, setRequest] = React.useState<PresetRequest>({ range: '90d', nonce: 0 });
  const choosePreset = (preset: SettlementRange) => {
    setRange(preset);
    setRequest((previous) => ({ range: preset, nonce: previous.nonce + 1 }));
  };

  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
        <Segmented label="Chart view" onChange={setView} options={VIEWS} value={view} />
        {view === 'settlement' && (
          <Segmented label="Range" onChange={choosePreset} options={SETTLEMENT_RANGES} value={range} />
        )}
      </div>
      <div className="flex flex-1 flex-col">
        {view === 'settlement' ? (
          <SettlementPriceChart onViewChange={setRange} request={request} />
        ) : selected ? (
          <div className="terminal-swap flex flex-1 flex-col" key={selected.address}>
            <CandlestickChart strikeDollars={chartStrikeDollars(selected)} />
          </div>
        ) : (
          <CandlestickChart />
        )}
      </div>
    </div>
  );
}
