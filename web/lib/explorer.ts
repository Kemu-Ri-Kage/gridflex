/**
 * OKLink's X Layer Testnet explorer. Pages are /tx/<hash> and
 * /address/<address>; the older /xlayer-test/ slug redirects here. Kept free
 * of imports so lib/contracts.ts and the node tests can both use it.
 */
export const EXPLORER_BASE_URL = 'https://www.oklink.com/x-layer-testnet';

export function explorerTxUrl(txHash: string): string {
  return `${EXPLORER_BASE_URL}/tx/${txHash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${EXPLORER_BASE_URL}/address/${address}`;
}
