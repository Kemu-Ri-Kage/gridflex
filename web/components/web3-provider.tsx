'use client';

import * as React from 'react';
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  http,
  type Address,
  type EIP1193Provider,
  type Hash,
} from 'viem';

import {
  addresses as envAddresses,
  binaryMarketAbi,
  mockUsdtAbi,
  outcomeTokenAbi,
  xLayerTestnet,
} from '@/lib/contracts';
import { useAddresses } from '@/lib/site-data';
import {
  DEFAULT_SLIPPAGE_BPS,
  minimumOutputForQuote,
  parsePositiveTokenAmount,
  swapDeadline,
} from '@/lib/trade';

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export type TradeSide = 'YES' | 'NO';

/**
 * One market's state as the order ticket needs it. `address` names the
 * market these numbers describe, so a snapshot read for one market can
 * never be shown beside another's name; `loaded` is false until the first
 * read of the current market lands.
 */
export type MarketSnapshot = {
  address?: Address;
  loaded: boolean;
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
  /** Unix seconds. Trading closes and resolve() opens at this instant. */
  resolveAfter: number;
  /** Seconds after resolveAfter before cancel() is available. */
  disputeWindow: number;
};

/** A Buy YES / Buy NO quote: mint `amount` of both sides, swap the other side in. */
export type BuyQuote = {
  /** The mUSDT locked, which is also the count of each side minted. */
  amountIn: bigint;
  /** What swapping the unwanted side into the wanted one returns now. */
  swapOut: bigint;
  minimumSwapOut: bigint;
  /** amountIn + swapOut: the wanted side held after both steps. */
  totalOut: bigint;
  minimumTotalOut: bigint;
  slippageBps: bigint;
};

type Web3ContextValue = {
  account?: Address;
  /** undefined until mounted; false when no EIP-1193 wallet is injected. */
  walletDetected?: boolean;
  /** True when a collateral token and a market are known. */
  configured: boolean;
  /** The market every read and transaction targets. Set by selectMarket. */
  market?: Address;
  selectMarket: (address?: Address) => void;
  snapshot: MarketSnapshot;
  pendingAction?: string;
  /** Trade and read errors, shown in the order ticket. */
  error?: string;
  /** Wallet connection errors only, shown under the Connect button. */
  connectError?: string;
  lastTransaction?: Hash;
  connect: () => Promise<void>;
  disconnect: () => void;
  refresh: () => Promise<void>;
  mintCollateral: () => Promise<void>;
  quoteBuy: (side: TradeSide, amount: string) => Promise<BuyQuote | undefined>;
  buy: (side: TradeSide, amount: string) => Promise<void>;
  resolve: () => Promise<void>;
  cancel: () => Promise<void>;
  redeem: () => Promise<void>;
};

const emptySnapshot: MarketSnapshot = {
  loaded: false,
  priceE18: 500_000_000_000_000_000n,
  yesReserve: 0n,
  noReserve: 0n,
  collateralBalance: 0n,
  yesBalance: 0n,
  noBalance: 0n,
  resolved: false,
  cancelled: false,
  yesWon: false,
  resolveAfter: 0,
  disputeWindow: 0,
};

export const NO_WALLET_MESSAGE =
  'No wallet found in this browser. Install OKX Wallet or MetaMask, then reload.';

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

function subscribeToNothing() {
  return () => {};
}

function validAddress(value: string | undefined): Address | undefined {
  return value && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? getAddress(value)
    : undefined;
}

export function Web3Provider({ children }: { children: React.ReactNode }) {
  const published = useAddresses();
  // The collateral every market uses: from the published address file
  // (build_feed_data.py's write_addresses), or the env override if set.
  const collateral = React.useMemo<Address | undefined>(
    () => envAddresses.collateral ?? validAddress(published?.MockUSDT),
    [published],
  );

  const [account, setAccount] = React.useState<Address>();
  // Whether an EIP-1193 wallet is injected: read from the window on the
  // client, undefined during server rendering.
  const walletDetected = React.useSyncExternalStore(
    subscribeToNothing,
    () => Boolean(window.ethereum),
    () => undefined,
  );
  const [market, setMarket] = React.useState<Address>();
  const [snapshot, setSnapshot] = React.useState<MarketSnapshot>(emptySnapshot);
  const [pendingAction, setPendingAction] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  const [connectError, setConnectError] = React.useState<string>();
  const [lastTransaction, setLastTransaction] = React.useState<Hash>();
  // The market the latest read was started for; a read that finishes after
  // the selection moved on is dropped rather than shown for the new market.
  const marketRef = React.useRef<Address | undefined>(undefined);

  const selectMarket = React.useCallback((address?: Address) => {
    const next = address ? getAddress(address) : undefined;
    if (marketRef.current === next) return;
    marketRef.current = next;
    setMarket(next);
    setSnapshot(emptySnapshot);
    setError(undefined);
    setLastTransaction(undefined);
  }, []);

  const connect = React.useCallback(async () => {
    setConnectError(undefined);
    const ethereum = window.ethereum;
    if (!ethereum) {
      setConnectError(NO_WALLET_MESSAGE);
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
    } catch (walletError) {
      setConnectError(errorMessage(walletError));
    }
  }, []);

  const disconnect = React.useCallback(() => {
    setAccount(undefined);
    setConnectError(undefined);
    setSnapshot((current) => ({
      ...current,
      collateralBalance: 0n,
      yesBalance: 0n,
      noBalance: 0n,
    }));
  }, []);

  const refresh = React.useCallback(async () => {
    const target = marketRef.current;
    if (!target) return;

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
        resolveAfter,
        disputeWindow,
      ] = await publicClient.multicall({
        allowFailure: false,
        contracts: [
          'price',
          'yesReserve',
          'noReserve',
          'yesToken',
          'noToken',
          'resolved',
          'cancelled',
          'yesWon',
          'resolveAfter',
          'disputeWindow',
        ].map((functionName) => ({
          address: target,
          abi: binaryMarketAbi,
          functionName,
        })),
      });

      const outcomeAddresses = [yesToken as Address, noToken as Address];
      let collateralBalance = 0n;
      let yesBalance = 0n;
      let noBalance = 0n;
      if (account && collateral) {
        [collateralBalance, yesBalance, noBalance] =
          (await publicClient.multicall({
            allowFailure: false,
            contracts: [
              {
                address: collateral,
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

      if (marketRef.current !== target) return;
      setSnapshot({
        address: target,
        loaded: true,
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
        resolveAfter: Number(resolveAfter),
        disputeWindow: Number(disputeWindow),
      });
    } catch (readError) {
      if (marketRef.current !== target) return;
      setError(`Could not read X Layer: ${errorMessage(readError)}`);
    }
  }, [account, collateral]);

  React.useEffect(() => {
    if (!market) return;
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [market, refresh]);

  React.useEffect(() => {
    const ethereum = window.ethereum;
    if (!ethereum?.on) return;

    const handleAccounts = (nextAccounts: unknown) => {
      const next = Array.isArray(nextAccounts) ? nextAccounts[0] : undefined;
      setAccount(typeof next === 'string' ? getAddress(next) : undefined);
    };
    const handleChain = () => void refresh();
    ethereum.on('accountsChanged', handleAccounts);
    ethereum.on('chainChanged', handleChain);
    return () => {
      ethereum.removeListener?.('accountsChanged', handleAccounts);
      ethereum.removeListener?.('chainChanged', handleChain);
    };
  }, [refresh]);

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

  /** Approve `spender` for `amount` of `token` unless the allowance already covers it. */
  const ensureAllowance = React.useCallback(
    async (
      label: string,
      token: Address,
      abi: typeof mockUsdtAbi,
      spender: Address,
      amount: bigint,
    ): Promise<boolean> => {
      if (!account) return false;
      try {
        const allowance = (await publicClient.readContract({
          address: token,
          abi,
          functionName: 'allowance',
          args: [account, spender],
        })) as bigint;
        if (allowance >= amount) return true;
      } catch {
        // Fall through and approve; a failed read must not block the trade.
      }
      return write(label, {
        address: token,
        abi,
        functionName: 'approve',
        args: [spender, amount],
      });
    },
    [account, write],
  );

  const mintCollateral = React.useCallback(async () => {
    if (!collateral || !account) return;
    await write('Getting demo mUSDT', {
      address: collateral,
      abi: mockUsdtAbi,
      functionName: 'mint',
      args: [account, parsePositiveTokenAmount('1000')],
    });
  }, [account, collateral, write]);

  const quoteBuy = React.useCallback(
    async (side: TradeSide, amount: string): Promise<BuyQuote | undefined> => {
      const target = marketRef.current;
      if (!target) return undefined;
      const units = parsePositiveTokenAmount(amount);
      // Buying YES sends the minted NO into the pool (yesForNo = false).
      const yesForNo = side === 'NO';
      const swapOut = (await publicClient.readContract({
        address: target,
        abi: binaryMarketAbi,
        functionName: 'quoteSwap',
        args: [yesForNo, units],
      })) as bigint;
      const minimumSwapOut = minimumOutputForQuote(swapOut);
      return {
        amountIn: units,
        swapOut,
        minimumSwapOut,
        totalOut: units + swapOut,
        minimumTotalOut: units + minimumSwapOut,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
      };
    },
    [],
  );

  /**
   * Buy YES or Buy NO in one action: lock `amount` mUSDT for a complete set,
   * then swap the unwanted side into the wanted one with the same slippage
   * guard and deadline the contract enforces. Approvals are sent only when
   * the current allowance does not already cover the step.
   */
  const buy = React.useCallback(
    async (side: TradeSide, amount: string) => {
      const target = marketRef.current;
      if (!collateral || !target) {
        setError('Contracts not configured.');
        return;
      }
      let units: bigint;
      try {
        units = parsePositiveTokenAmount(amount);
      } catch (amountError) {
        setError(errorMessage(amountError));
        return;
      }

      let protectedQuote: BuyQuote | undefined;
      try {
        protectedQuote = await quoteBuy(side, amount);
        if (!protectedQuote)
          throw new Error('The market quote is unavailable.');
      } catch (quoteError) {
        setError(`Could not prepare the order: ${errorMessage(quoteError)}`);
        return;
      }

      const approved = await ensureAllowance(
        'Approving mUSDT',
        collateral,
        mockUsdtAbi,
        target,
        units,
      );
      if (!approved) return;
      const minted = await write(`Buying ${side}`, {
        address: target,
        abi: binaryMarketAbi,
        functionName: 'mintSet',
        args: [units],
      });
      if (!minted) return;

      const yesForNo = side === 'NO';
      const tokens = (await publicClient.multicall({
        allowFailure: false,
        contracts: [
          { address: target, abi: binaryMarketAbi, functionName: 'yesToken' },
          { address: target, abi: binaryMarketAbi, functionName: 'noToken' },
        ],
      })) as [Address, Address];
      const inputToken = yesForNo ? tokens[0] : tokens[1];

      const inputApproved = await ensureAllowance(
        `Approving ${yesForNo ? 'YES' : 'NO'}`,
        inputToken,
        outcomeTokenAbi,
        target,
        units,
      );
      if (!inputApproved) return;

      let deadline: bigint;
      try {
        const latestQuote = await quoteBuy(side, amount);
        if (!latestQuote) throw new Error('The market quote is unavailable.');
        if (latestQuote.swapOut < protectedQuote.minimumSwapOut) {
          throw new Error(
            'The price moved beyond the 0.50% tolerance while the order was being prepared. Review the new quote and try again.',
          );
        }
        const latestBlock = await publicClient.getBlock({ blockTag: 'latest' });
        deadline = swapDeadline(latestBlock.timestamp);
      } catch (quoteError) {
        setError(`Could not prepare the order: ${errorMessage(quoteError)}`);
        return;
      }

      await write(`Buying ${side}`, {
        address: target,
        abi: binaryMarketAbi,
        functionName: 'swap',
        args: [yesForNo, units, protectedQuote.minimumSwapOut, deadline],
      });
    },
    [collateral, ensureAllowance, quoteBuy, write],
  );

  const resolve = React.useCallback(async () => {
    const target = marketRef.current;
    if (!target) return;
    await write('Resolving', {
      address: target,
      abi: binaryMarketAbi,
      functionName: 'resolve',
    });
  }, [write]);

  const redeem = React.useCallback(async () => {
    const target = marketRef.current;
    if (!target) return;
    await write('Redeeming', {
      address: target,
      abi: binaryMarketAbi,
      functionName: 'redeem',
    });
  }, [write]);

  const cancel = React.useCallback(async () => {
    const target = marketRef.current;
    if (!target) return;
    await write('Cancelling', {
      address: target,
      abi: binaryMarketAbi,
      functionName: 'cancel',
    });
  }, [write]);

  const value = React.useMemo<Web3ContextValue>(
    () => ({
      account,
      walletDetected,
      configured: Boolean(collateral && market),
      market,
      selectMarket,
      snapshot,
      pendingAction,
      error,
      connectError,
      lastTransaction,
      connect,
      disconnect,
      refresh,
      mintCollateral,
      quoteBuy,
      buy,
      resolve,
      cancel,
      redeem,
    }),
    [
      account,
      walletDetected,
      collateral,
      market,
      selectMarket,
      snapshot,
      pendingAction,
      error,
      connectError,
      lastTransaction,
      connect,
      disconnect,
      refresh,
      mintCollateral,
      quoteBuy,
      buy,
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
