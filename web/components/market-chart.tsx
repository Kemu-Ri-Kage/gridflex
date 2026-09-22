'use client';

import { CandlestickChart } from '@/components/candlestick-chart';
import { chartStrikeDollars, marketHub, useMarkets } from '@/lib/markets';

/** The chart for the selected market: its hub, and its strike when the strike is a hub price. */
export function MarketChart() {
  const { selected } = useMarkets();
  if (!selected) return <CandlestickChart />;
  return (
    <CandlestickChart
      defaultHub={marketHub(selected)}
      key={selected.address}
      strikeDollars={chartStrikeDollars(selected)}
    />
  );
}
