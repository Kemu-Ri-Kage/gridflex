import { formatUnits } from 'viem';

export function formatToken(value: bigint): string {
  return Number(formatUnits(value, 6)).toLocaleString('en-US', {
    maximumFractionDigits: 2,
  });
}
