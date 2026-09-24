import {
  defineChain,
  fallback,
  getAddress,
  http,
  type Abi,
  type Address,
} from 'viem';

// Relative, extension-qualified imports so scripts/hedge-agent.ts can load
// this file straight into Node as well as through Vite.
import { EXPLORER_BASE_URL } from './explorer.ts';
import binaryMarketAbiJson from './abi/BinaryMarket.json' with { type: 'json' };
import gridOracleAbiJson from './abi/GridOracle.json' with { type: 'json' };
import marketFactoryAbiJson from './abi/MarketFactory.json' with { type: 'json' };
import mockUsdtAbiJson from './abi/MockUSDT.json' with { type: 'json' };
import outcomeTokenAbiJson from './abi/OutcomeToken.json' with { type: 'json' };

/**
 * X Layer testnet RPC endpoints, in the order they are tried. Both reject
 * eth_getLogs spans over 100 blocks. The wallet keeps its own saved RPC for
 * this chain; these only reach it through wallet_addEthereumChain, which a
 * wallet honours when it doesn't have chain 1952 yet.
 */
export const XLAYER_TESTNET_RPC_URLS = [
  'https://testrpc.xlayer.tech/terigon',
  'https://xlayertestrpc.okx.com/terigon',
] as const;

export const xLayerTestnet = defineChain({
  id: 1952,
  name: 'X Layer Testnet',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: {
    default: {
      http: XLAYER_TESTNET_RPC_URLS,
    },
  },
  blockExplorers: {
    default: {
      name: 'OKLink',
      url: EXPLORER_BASE_URL,
    },
  },
  // Canonical Multicall3, verified deployed on chain 1952. blockCreated is
  // omitted, so multicall is only used at the latest block; the one read
  // pinned to past blocks (position history in lib/markets.tsx) uses plain
  // eth_call.
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
  // About one block a second; viem polls receipts at half this.
  blockTime: 1_000,
  testnet: true,
});

/**
 * The transport for the app's own reads: the endpoints above in order, the
 * second used only when the first fails. rank: false keeps that order
 * fixed instead of re-sorting by measured latency.
 */
export function xLayerTransport() {
  return fallback(
    XLAYER_TESTNET_RPC_URLS.map((url) => http(url)),
    { rank: false },
  );
}

function optionalAddress(value: string | undefined): Address | undefined {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value)) {
    return undefined;
  }
  return getAddress(value);
}

/**
 * Optional build-time overrides. The site normally takes every address from
 * /data/addresses.json (written from shared/addresses.json by
 * build_feed_data.py), and the order ticket trades whichever listed market
 * is selected - there is no single "demo market" address any more.
 */
export const addresses = {
  oracle: optionalAddress(process.env.NEXT_PUBLIC_GRID_ORACLE_ADDRESS),
  factory: optionalAddress(process.env.NEXT_PUBLIC_MARKET_FACTORY_ADDRESS),
  collateral: optionalAddress(process.env.NEXT_PUBLIC_MOCK_USDT_ADDRESS),
} as const;

export const binaryMarketAbi = binaryMarketAbiJson as Abi;
export const gridOracleAbi = gridOracleAbiJson as Abi;
export const marketFactoryAbi = marketFactoryAbiJson as Abi;
export const mockUsdtAbi = mockUsdtAbiJson as Abi;
export const outcomeTokenAbi = outcomeTokenAbiJson as Abi;
