'use client';

import { CandlestickChart } from '@/components/candlestick-chart';
import { chartStrikeDollars, useMarkets } from '@/lib/markets';

/** The chart for the selected market, with its strike line. */
export function MarketChart() {
  const { selected } = useMarkets();
  if (!selected) return <CandlestickChart />;
  return (
    <CandlestickChart key={selected.address} strikeDollars={chartStrikeDollars(selected)} />
  );
}
