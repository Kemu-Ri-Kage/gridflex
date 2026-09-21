import { xLayerTestnet } from '@/lib/contracts';

const EXPLORER = xLayerTestnet.blockExplorers.default.url;

export function explorerTxUrl(txHash: string): string {
  return `${EXPLORER}/tx/${txHash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${EXPLORER}/address/${address}`;
}
