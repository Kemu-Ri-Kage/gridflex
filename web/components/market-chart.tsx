'use client';

import * as React from 'react';

import { CandlestickChart } from '@/components/candlestick-chart';
import {
  SETTLEMENT_RANGES,
  SettlementPriceChart,
  type SettlementRange,
} from '@/components/settlement-price-chart';
import { chartStrikeDollars, useMarkets } from '@/lib/markets';

type View = 'settlement' | 'live';

const VIEWS: { id: View; label: string }[] = [
  { id: 'settlement', label: 'Settlement price' },
  { id: 'live', label: 'Live price' },
];

function Toggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex gap-1">
      {options.map((option) => (
        <button
          aria-pressed={value === option.id}
          className={
            'border px-2.5 py-1 font-mono text-xs ' +
            (value === option.id
              ? 'border-foreground text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground')
          }
          key={option.id}
          onClick={() => onChange(option.id)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The centre chart, in two views (design-brief.md §9). Settlement price,
 * the default: the verified daily price markets settle on, with every
 * listed strike. Live price: real-time candles for reference, with the
 * selected market's strike line.
 */
export function MarketChart() {
  const { selected } = useMarkets();
  const [view, setView] = React.useState<View>('settlement');
  const [range, setRange] = React.useState<SettlementRange>('90d');

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
        <Toggle onChange={setView} options={VIEWS} value={view} />
        {view === 'settlement' && <Toggle onChange={setRange} options={SETTLEMENT_RANGES} value={range} />}
      </div>
      <div className="flex flex-1 flex-col">
        {view === 'settlement' ? (
          <SettlementPriceChart range={range} />
        ) : selected ? (
          <CandlestickChart key={selected.address} strikeDollars={chartStrikeDollars(selected)} />
        ) : (
          <CandlestickChart />
        )}
      </div>
    </div>
  );
}
