'use client';

import * as React from 'react';
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  http,
  parseUnits,
  type Address,
  type EIP1193Provider,
  type Hash,
} from 'viem';

import {
  addresses,
  binaryMarketAbi,
  contractsConfigured,
  mockUsdtAbi,
  outcomeTokenAbi,
  xLayerTestnet,
} from '@/lib/contracts';

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

type MarketSnapshot = {
  priceE18: bigint;
  yesReserve: bigint;
  noReserve: bigint;
  yesToken?: Address;
  noToken?: Address;
  collateralBalance: bigint;
  yesBalance: bigint;
  noBalance: bigint;
  resolved: boolean;
  cancelled: boolean;
  yesWon: boolean;
};

type Web3ContextValue = {
  account?: Address;
  configured: boolean;
  snapshot: MarketSnapshot;
  pendingAction?: string;
  error?: string;
  lastTransaction?: Hash;
  connect: () => Promise<void>;
  disconnect: () => void;
  refresh: () => Promise<void>;
  mintCollateral: () => Promise<void>;
  mintSet: (amount: string) => Promise<void>;
  swapToward: (side: 'YES' | 'NO', amount: string) => Promise<void>;
  resolve: () => Promise<void>;
  cancel: () => Promise<void>;
  redeem: () => Promise<void>;
};

const demoSnapshot: MarketSnapshot = {
  priceE18: 500_000_000_000_000_000n,
  yesReserve: 10_000_000_000n,
  noReserve: 10_000_000_000n,
  collateralBalance: 0n,
  yesBalance: 0n,
  noBalance: 0n,
  resolved: false,
  cancelled: false,
  yesWon: false,
};

const Web3Context = React.createContext<Web3ContextValue | null>(null);
const publicClient = createPublicClient({
  chain: xLayerTestnet,
  transport: http(),
});

function errorMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  if (error instanceof Error) return error.message;
  return 'The wallet rejected or could not complete the request.';
}

export function Web3Provider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = React.useState<Address>();
  const [snapshot, setSnapshot] = React.useState<MarketSnapshot>(demoSnapshot);
  const [pendingAction, setPendingAction] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  const [lastTransaction, setLastTransaction] = React.useState<Hash>();

  const connect = React.useCallback(async () => {
    setError(undefined);
    const ethereum = window.ethereum;
    if (!ethereum) {
      setError('MetaMask or another EVM wallet was not found in this browser.');
      return;
    }

    try {
      const accounts = (await ethereum.request({
        method: 'eth_requestAccounts',
      })) as Address[];
      if (!accounts[0])
        throw new Error('The wallet did not return an account.');

      try {
        await ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0x7a0' }],
        });
      } catch (switchError) {
        const code =
          typeof switchError === 'object' &&
          switchError &&
          'code' in switchError
            ? Number(switchError.code)
            : undefined;
        if (code !== 4902) throw switchError;

        await ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: '0x7a0',
              chainName: 'X Layer Testnet',
              nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
              rpcUrls: xLayerTestnet.rpcUrls.default.http,
              blockExplorerUrls: [xLayerTestnet.blockExplorers.default.url],
            },
          ],
        });
      }

      setAccount(getAddress(accounts[0]));
    } catch (connectError) {
      setError(errorMessage(connectError));
    }
  }, []);

  const disconnect = React.useCallback(() => {
    setAccount(undefined);
    setSnapshot((current) => ({
      ...current,
      collateralBalance: 0n,
      yesBalance: 0n,
      noBalance: 0n,
    }));
  }, []);

  const refresh = React.useCallback(async () => {
    const marketAddress = addresses.market;
    if (!marketAddress) return;

    try {
      const [
        priceE18,
        yesReserve,
        noReserve,
        yesToken,
        noToken,
        resolved,
        cancelled,
        yesWon,
      ] = await publicClient.multicall({
        allowFailure: false,
        contracts: [
          {
            address: marketAddress,
            abi: binaryMarketAbi,
            functionName: 'price',
          },
          {
            address: marketAddress,
            abi: binaryMarketAbi,
            functionName: 'yesReserve',
          },
          {
            address: marketAddress,
            abi: binaryMarketAbi,
            functionName: 'noReserve',
          },
          {
            address: marketAddress,
            abi: binaryMarketAbi,
            functionName: 'yesToken',
          },
          {
            address: marketAddress,
            abi: binaryMarketAbi,
            functionName: 'noToken',
          },
          {
            address: marketAddress,
            abi: binaryMarketAbi,
            functionName: 'resolved',
          },
          {
            address: marketAddress,
            abi: binaryMarketAbi,
            functionName: 'cancelled',
          },
          {
            address: marketAddress,
            abi: binaryMarketAbi,
            functionName: 'yesWon',
          },
        ],
      });

      const outcomeAddresses = [yesToken as Address, noToken as Address];
      let collateralBalance = 0n;
      let yesBalance = 0n;
      let noBalance = 0n;
      if (account && addresses.collateral) {
        [collateralBalance, yesBalance, noBalance] =
          (await publicClient.multicall({
            allowFailure: false,
            contracts: [
              {
                address: addresses.collateral,
                abi: mockUsdtAbi,
                functionName: 'balanceOf',
                args: [account],
              },
              {
                address: outcomeAddresses[0],
                abi: outcomeTokenAbi,
                functionName: 'balanceOf',
                args: [account],
              },
              {
                address: outcomeAddresses[1],
                abi: outcomeTokenAbi,
                functionName: 'balanceOf',
                args: [account],
              },
            ],
          })) as [bigint, bigint, bigint];
      }

      setSnapshot({
        priceE18: priceE18 as bigint,
        yesReserve: yesReserve as bigint,
        noReserve: noReserve as bigint,
        yesToken: outcomeAddresses[0],
        noToken: outcomeAddresses[1],
        collateralBalance,
        yesBalance,
        noBalance,
        resolved: resolved as boolean,
        cancelled: cancelled as boolean,
        yesWon: yesWon as boolean,
      });
    } catch (readError) {
      setError(`Could not read X Layer: ${errorMessage(readError)}`);
    }
  }, [account]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  React.useEffect(() => {
    const ethereum = window.ethereum;
    if (!ethereum?.on) return;

    const handleAccounts = (nextAccounts: unknown) => {
      const next = Array.isArray(nextAccounts) ? nextAccounts[0] : undefined;
      setAccount(typeof next === 'string' ? getAddress(next) : undefined);
    };
    ethereum.on('accountsChanged', handleAccounts);
    return () => ethereum.removeListener?.('accountsChanged', handleAccounts);
  }, []);

  const write = React.useCallback(
    async (
      label: string,
      request: {
        address: Address;
        abi: typeof binaryMarketAbi;
        functionName: string;
        args?: readonly unknown[];
      },
    ): Promise<boolean> => {
      const ethereum = window.ethereum;
      if (!ethereum || !account) {
        setError('Connect a wallet before sending a transaction.');
        return false;
      }

      setPendingAction(label);
      setError(undefined);
      try {
        const walletClient = createWalletClient({
          account,
          chain: xLayerTestnet,
          transport: custom(ethereum),
        });
        const hash = await walletClient.writeContract({
          address: request.address,
          abi: request.abi,
          functionName: request.functionName,
          args: request.args,
        });
        setLastTransaction(hash);
        await publicClient.waitForTransactionReceipt({ hash });
        await refresh();
        return true;
      } catch (writeError) {
        setError(errorMessage(writeError));
        return false;
      } finally {
        setPendingAction(undefined);
      }
    },
    [account, refresh],
  );

  const mintCollateral = React.useCallback(async () => {
    if (!addresses.collateral || !account) return;
    await write('Minting test collateral', {
      address: addresses.collateral,
      abi: mockUsdtAbi,
      functionName: 'mint',
      args: [account, parseUnits('1000', 6)],
    });
  }, [account, write]);

  const mintSet = React.useCallback(
    async (amount: string) => {
      if (!addresses.collateral || !addresses.market) return;
      const units = parseUnits(amount, 6);
      const approved = await write('Approving collateral', {
        address: addresses.collateral,
        abi: mockUsdtAbi,
        functionName: 'approve',
        args: [addresses.market, units],
      });
      if (!approved) return;
      await write('Minting YES + NO set', {
        address: addresses.market,
        abi: binaryMarketAbi,
        functionName: 'mintSet',
        args: [units],
      });
    },
    [write],
  );

  const swapToward = React.useCallback(
    async (side: 'YES' | 'NO', amount: string) => {
      if (!addresses.market || !snapshot.yesToken || !snapshot.noToken) return;
      const units = parseUnits(amount, 6);
      const yesForNo = side === 'NO';
      const inputToken = yesForNo ? snapshot.yesToken : snapshot.noToken;
      const approved = await write(`Approving ${yesForNo ? 'YES' : 'NO'}`, {
        address: inputToken,
        abi: outcomeTokenAbi,
        functionName: 'approve',
        args: [addresses.market, units],
      });
      if (!approved) return;
      await write(`Swapping toward ${side}`, {
        address: addresses.market,
        abi: binaryMarketAbi,
        functionName: 'swap',
        args: [yesForNo, units],
      });
    },
    [snapshot.noToken, snapshot.yesToken, write],
  );

  const resolve = React.useCallback(async () => {
    if (!addresses.market) return;
    await write('Resolving market', {
      address: addresses.market,
      abi: binaryMarketAbi,
      functionName: 'resolve',
    });
  }, [write]);

  const redeem = React.useCallback(async () => {
    if (!addresses.market) return;
    await write('Redeeming outcome tokens', {
      address: addresses.market,
      abi: binaryMarketAbi,
      functionName: 'redeem',
    });
  }, [write]);

  const cancel = React.useCallback(async () => {
    if (!addresses.market) return;
    await write('Cancelling unresolvable market', {
      address: addresses.market,
      abi: binaryMarketAbi,
      functionName: 'cancel',
    });
  }, [write]);

  const value = React.useMemo<Web3ContextValue>(
    () => ({
      account,
      configured: contractsConfigured,
      snapshot,
      pendingAction,
      error,
      lastTransaction,
      connect,
      disconnect,
      refresh,
      mintCollateral,
      mintSet,
      swapToward,
      resolve,
      cancel,
      redeem,
    }),
    [
      account,
      snapshot,
      pendingAction,
      error,
      lastTransaction,
      connect,
      disconnect,
      refresh,
      mintCollateral,
      mintSet,
      swapToward,
      resolve,
      cancel,
      redeem,
    ],
  );

  return <Web3Context.Provider value={value}>{children}</Web3Context.Provider>;
}

export function useWeb3() {
  const value = React.useContext(Web3Context);
  if (!value) throw new Error('useWeb3 must be used within Web3Provider.');
  return value;
}
