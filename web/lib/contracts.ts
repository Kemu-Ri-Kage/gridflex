import { defineChain, getAddress, type Abi, type Address } from 'viem';

import binaryMarketAbiJson from '@/lib/abi/BinaryMarket.json';
import gridOracleAbiJson from '@/lib/abi/GridOracle.json';
import marketFactoryAbiJson from '@/lib/abi/MarketFactory.json';
import mockUsdtAbiJson from '@/lib/abi/MockUSDT.json';
import outcomeTokenAbiJson from '@/lib/abi/OutcomeToken.json';

export const xLayerTestnet = defineChain({
  id: 1952,
  name: 'X Layer Testnet',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        process.env.NEXT_PUBLIC_XLAYER_RPC_URL ??
          'https://testrpc.xlayer.tech/terigon',
      ],
    },
  },
  blockExplorers: {
    default: {
      name: 'OKX Explorer',
      url: 'https://www.okx.com/web3/explorer/xlayer-test',
    },
  },
  // Canonical Multicall3, verified deployed on chain 1952. blockCreated is
  // omitted: the public RPC isn't an archive node, and it only matters for
  // reads pinned to past blocks, which the app doesn't make.
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
  testnet: true,
});

function optionalAddress(value: string | undefined): Address | undefined {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value)) {
    return undefined;
  }
  return getAddress(value);
}

export const addresses = {
  oracle: optionalAddress(process.env.NEXT_PUBLIC_GRID_ORACLE_ADDRESS),
  factory: optionalAddress(process.env.NEXT_PUBLIC_MARKET_FACTORY_ADDRESS),
  collateral: optionalAddress(process.env.NEXT_PUBLIC_MOCK_USDT_ADDRESS),
  market: optionalAddress(process.env.NEXT_PUBLIC_DEMO_MARKET_ADDRESS),
} as const;

export const contractsConfigured = Boolean(
  addresses.collateral && addresses.market,
);

export const binaryMarketAbi = binaryMarketAbiJson as Abi;
export const gridOracleAbi = gridOracleAbiJson as Abi;
export const marketFactoryAbi = marketFactoryAbiJson as Abi;
export const mockUsdtAbi = mockUsdtAbiJson as Abi;
export const outcomeTokenAbi = outcomeTokenAbiJson as Abi;
