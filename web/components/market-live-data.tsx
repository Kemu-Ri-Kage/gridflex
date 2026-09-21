'use client';

import { useWeb3 } from '@/components/web3-provider';
import { formatToken } from '@/lib/format';

export function MarketProbability() {
  const { snapshot } = useWeb3();
  const percent = Number(snapshot.priceE18) / 1e16;
  return (
    <>
      {percent.toFixed(1)}
      <span className="text-xl text-muted-foreground">%</span>
    </>
  );
}

export function ReserveStat({ side }: { side: 'YES' | 'NO' }) {
  const { snapshot } = useWeb3();
  const reserve = side === 'YES' ? snapshot.yesReserve : snapshot.noReserve;
  return <>{formatToken(reserve)} mUSDT</>;
}
