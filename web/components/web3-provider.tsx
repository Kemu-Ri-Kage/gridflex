'use client';

import * as React from 'react';
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
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
  xLayerTransport,
} from '@/lib/contracts';
import {
  clearPendingOrder,
  loadPendingOrder,
  pendingOrderUnits,
  savePendingOrder,
  type PendingOrder,
  type PendingOrderStorage,
} from '@/lib/pending-order';
import { useAddresses } from '@/lib/site-data';
import { runBuy } from '@/lib/buy-flow';
import {
  DEFAULT_SLIPPAGE_BPS,
  minimumOutputForQuote,
  parsePositiveTokenAmount,
  swapDeadline,
} from '@/lib/trade';
import {
  assertTransactionSucceeded,
  TransactionRevertedError,
} from '@/lib/transaction-outcome';
import { singleFlight } from '@/lib/single-flight';
import {
  isUnknownChainError,
  isWalletRpcFailure,
  walletErrorMessage,
  walletRequestAlreadyPending,
} from '@/lib/wallet-errors';
import {
  checkWalletRpc,
  type WalletRpcVerdict,
  watchSlowRequest,
} from '@/lib/wallet-health';

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export type TradeSide = 'YES' | 'NO';
export type { PendingOrder } from '@/lib/pending-order';

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

/**
 * A Switch position quote: send `amountIn` of one side, receive the other.
 * No mUSDT moves; this changes side, it is not a sale.
 */
export type SwitchQuote = {
  from: TradeSide;
  to: TradeSide;
  amountIn: bigint;
  amountOut: bigint;
  minimumOut: bigint;
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
  /** A connect() is waiting on the wallet; Connect stays disabled. */
  connecting: boolean;
  /**
   * The wallet's own saved RPC for X Layer looks unreachable: a connected,
   * unlocked wallet on X Layer failed the health check twice
   * (lib/wallet-health.ts), or a transaction failed in a way that points
   * at it (lib/wallet-errors.ts). Checked on connect, on a chain change and
   * while a transaction is slow; cleared by the next check or request that
   * succeeds. Never stops a request being sent.
   */
  walletRpcFailed: boolean;
  lastTransaction?: Hash;
  /** The reverted transaction behind `error`, linked beside it. */
  failedTransaction?: Hash;
  connect: () => Promise<void>;
  disconnect: () => void;
  refresh: () => Promise<void>;
  mintCollateral: () => Promise<void>;
  quoteBuy: (side: TradeSide, amount: string) => Promise<BuyQuote | undefined>;
  buy: (side: TradeSide, amount: string) => Promise<void>;
  /**
   * A buy whose mint confirmed but whose swap did not, on any market, for
   * the connected wallet. While it exists no new order may start.
   */
  pendingOrder?: PendingOrder;
  /** Quote switching `amount` (in tokens) of `from` into the other side. */
  quoteSwitch: (
    from: TradeSide,
    amount: string,
  ) => Promise<SwitchQuote | undefined>;
  /**
   * Swap `amount` of `from` into the other side, refused if the output
   * falls below `minimumOut` (the quote shown before confirming) or the
   * 5-minute deadline passes.
   */
  switchPosition: (
    from: TradeSide,
    amount: string,
    minimumOut: bigint,
  ) => Promise<void>;
  /** Retry the swap for pendingOrder; clears it once the swap confirms. */
  finishPendingOrder: () => Promise<void>;
  /** Forget pendingOrder and keep the YES + NO pair as it is. */
  keepBothSides: () => void;
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

/**
 * Shown in place of viem's text when the wallet's own RPC failed: for a
 * contract write viem words that as a revert, which it isn't.
 */
const WALLET_RPC_MESSAGE =
  "Your wallet couldn't reach X Layer through the RPC address it has saved for this network.";

/** The health check failed while a wallet request was still pending. */
const WALLET_RPC_STALLED_MESSAGE = `${WALLET_RPC_MESSAGE} The request is still open in the wallet; if a prompt appears, you can confirm or reject it there.`;

/**
 * Check the injected wallet's saved RPC for X Layer, or `unknown` when
 * there is no wallet (every wallet action already refuses that case).
 */
async function walletRpcVerdict(): Promise<WalletRpcVerdict> {
  const ethereum = window.ethereum;
  if (!ethereum) return 'unknown';
  return checkWalletRpc(
    (args) =>
      ethereum.request(args as Parameters<EIP1193Provider['request']>[0]),
    xLayerTestnet.id,
  );
}

export const NO_WALLET_MESSAGE =
  'No wallet found in this browser. Install OKX Wallet or MetaMask, then reload.';

/** Every custom error the market and its tokens can revert with, for decoding. */
const revertAbi = [
  ...binaryMarketAbi,
  ...mockUsdtAbi,
  ...outcomeTokenAbi,
].filter((item) => item.type === 'error');

const Web3Context = React.createContext<Web3ContextValue | null>(null);
const publicClient = createPublicClient({
  chain: xLayerTestnet,
  transport: xLayerTransport(),
});

/** Show or clear the connection help; `unknown` leaves it as it is. */
function applyRpcVerdict(
  verdict: WalletRpcVerdict,
  setWalletRpcFailed: (failed: boolean) => void,
) {
  if (verdict !== 'unknown') setWalletRpcFailed(verdict === 'unreachable');
}

function errorMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  if (error instanceof Error) return error.message;
  return 'The wallet rejected or could not complete the request.';
}

/** localStorage, or undefined where the browser blocks it. */
function browserStorage(): PendingOrderStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function subscribeToNothing() {
  return () => {};
}

function validAddress(value: string | undefined): Address | undefined {
  return value && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? getAddress(value)
    : undefined;
}

/** Quote buying `side` with `units` minted on `target`. */
async function quoteOn(
  target: Address,
  side: TradeSide,
  units: bigint,
): Promise<BuyQuote> {
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
  const [connecting, setConnecting] = React.useState(false);
  const [walletRpcFailed, setWalletRpcFailed] = React.useState(false);
  const [lastTransaction, setLastTransaction] = React.useState<Hash>();
  const [failedTransaction, setFailedTransaction] = React.useState<Hash>();
  // Held in state as well as localStorage, so an unfinished order still
  // blocks new ones for this session when the browser refuses storage.
  const [pendingOrder, setPendingOrder] = React.useState<PendingOrder>();
  // True from the moment a buy starts until it ends, so a second click
  // cannot start another order before the first one's mint is recorded.
  const orderInFlight = React.useRef(false);
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
    setFailedTransaction(undefined);
  }, []);

  // One connect at a time: a second click while the wallet prompt is open
  // would send another eth_requestAccounts, which MetaMask refuses with
  // -32002. The lock is released in singleFlight's finally.
  const [connectFlight] = React.useState(() =>
    singleFlight(async () => {
      setConnecting(true);
      try {
        await connectWallet();
      } finally {
        setConnecting(false);
      }
    }),
  );

  async function connectWallet() {
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
        if (!isUnknownChainError(switchError)) throw switchError;

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
      // Connecting and switching are answered by the wallet itself; this is
      // the first request that needs its RPC. Never awaited: it can't hold
      // up the connection.
      void walletRpcVerdict().then((verdict) =>
        applyRpcVerdict(verdict, setWalletRpcFailed),
      );
    } catch (walletError) {
      // Never read as a dead RPC: the wallet answers these requests without
      // it, so its -32002, -32603 or "timed out" is about the prompt or the
      // chain. Show the wallet's own words so a real problem is diagnosable.
      setConnectError(
        walletRequestAlreadyPending(walletError) ??
          walletErrorMessage(walletError) ??
          errorMessage(walletError),
      );
    }
  }

  const connect = React.useCallback(() => connectFlight.run(), [connectFlight]);

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
    const handleChain = () => {
      void refresh();
      if (account) {
        void walletRpcVerdict().then((verdict) =>
          applyRpcVerdict(verdict, setWalletRpcFailed),
        );
      }
    };
    ethereum.on('accountsChanged', handleAccounts);
    ethereum.on('chainChanged', handleChain);
    return () => {
      ethereum.removeListener?.('accountsChanged', handleAccounts);
      ethereum.removeListener?.('chainChanged', handleChain);
    };
  }, [account, refresh]);

  // Restore the connected wallet's unfinished order (after a reload, or on
  // switching wallets), and follow changes made in other tabs.
  React.useEffect(() => {
    const load = () =>
      setPendingOrder(
        account
          ? loadPendingOrder(browserStorage(), xLayerTestnet.id, account)
          : undefined,
      );
    load();
    window.addEventListener('storage', load);
    return () => window.removeEventListener('storage', load);
  }, [account]);

  const write = React.useCallback(
    async (
      label: string,
      request: {
        address: Address;
        abi: typeof binaryMarketAbi;
        functionName: string;
        args?: readonly unknown[];
      },
      /** Names this step in the error if it reverts; defaults to `label`. */
      step = label,
    ): Promise<boolean> => {
      const ethereum = window.ethereum;
      if (!ethereum || !account) {
        setError('Connect a wallet before sending a transaction.');
        return false;
      }

      setPendingAction(label);
      setError(undefined);
      setFailedTransaction(undefined);
      try {
        const walletClient = createWalletClient({
          account,
          chain: xLayerTestnet,
          transport: custom(ethereum),
        });
        // Only this request goes through the wallet's saved RPC; the
        // receipt and refresh below use the app's own endpoints.
        let hash: Hash;
        try {
          // Not timed out: a slow answer may be the user reading the prompt.
          // While it waits, re-check the RPC, and if that fails swap the
          // spinner for the connection help without dropping the request.
          hash = await watchSlowRequest(
            walletClient.writeContract({
              address: request.address,
              abi: request.abi,
              functionName: request.functionName,
              args: request.args,
            }),
            async () => {
              // Only a verdict of unreachable swaps the spinner for help;
              // when unsure, keep waiting on the wallet.
              if ((await walletRpcVerdict()) !== 'unreachable') return true;
              setWalletRpcFailed(true);
              setPendingAction(undefined);
              setError(WALLET_RPC_STALLED_MESSAGE);
              return false;
            },
          );
        } catch (walletError) {
          const alreadyPending = walletRequestAlreadyPending(walletError);
          if (alreadyPending) {
            throw new Error(alreadyPending, { cause: walletError });
          }
          if (!isWalletRpcFailure(walletError)) throw walletError;
          // The help panel waits for the health check's verdict; the message
          // carries the wallet's own words so the failure stays diagnosable.
          void walletRpcVerdict().then((verdict) =>
            applyRpcVerdict(verdict, setWalletRpcFailed),
          );
          const walletSaid = walletErrorMessage(walletError);
          throw new Error(
            walletSaid
              ? `${WALLET_RPC_MESSAGE} The wallet said: ${walletSaid}`
              : WALLET_RPC_MESSAGE,
            { cause: walletError },
          );
        }
        setWalletRpcFailed(false);
        setPendingAction(label);
        setError(undefined);
        setLastTransaction(hash);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        // A reverted transaction is mined too: replay it against the state
        // it ran on, so the node says why.
        await assertTransactionSucceeded(step, receipt, () =>
          publicClient.simulateContract({
            account,
            address: request.address,
            abi: [...request.abi, ...revertAbi],
            functionName: request.functionName,
            args: request.args,
            blockNumber: receipt.blockNumber - 1n,
          }),
        );
        await refresh();
        return true;
      } catch (writeError) {
        if (writeError instanceof TransactionRevertedError) {
          setLastTransaction(undefined);
          setFailedTransaction(writeError.hash);
          // Balances may have moved in the steps before this one.
          void refresh();
        }
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
      return quoteOn(target, side, parsePositiveTokenAmount(amount));
    },
    [],
  );

  /**
   * Swap `units` of the other side into `side`: the second step of a buy,
   * and the whole of a switch. Approves the input side if needed,
   * re-quotes, and swaps. With `protectedMinimum` (a fresh buy, or the
   * switch quote shown before confirming) the swap is refused if the price
   * moved past it; without it (finishing an unfinished order) the minimum
   * comes from the quote taken just before the swap. Returns whether it
   * confirmed.
   */
  const swapInto = React.useCallback(
    async (
      target: Address,
      side: TradeSide,
      units: bigint,
      protectedMinimum?: bigint,
      label = `Buying ${side}`,
    ): Promise<boolean> => {
      const yesForNo = side === 'NO';
      const inputSide: TradeSide = yesForNo ? 'YES' : 'NO';
      let inputToken: Address;
      try {
        const tokens = (await publicClient.multicall({
          allowFailure: false,
          contracts: [
            { address: target, abi: binaryMarketAbi, functionName: 'yesToken' },
            { address: target, abi: binaryMarketAbi, functionName: 'noToken' },
          ],
        })) as [Address, Address];
        inputToken = yesForNo ? tokens[0] : tokens[1];
      } catch (readError) {
        setError(`Could not read X Layer: ${errorMessage(readError)}`);
        return false;
      }

      const inputApproved = await ensureAllowance(
        `Approving ${inputSide}`,
        inputToken,
        outcomeTokenAbi,
        target,
        units,
      );
      if (!inputApproved) return false;

      let minimumSwapOut: bigint;
      let deadline: bigint;
      try {
        const latestQuote = await quoteOn(target, side, units);
        if (protectedMinimum === undefined) {
          minimumSwapOut = latestQuote.minimumSwapOut;
        } else if (latestQuote.swapOut < protectedMinimum) {
          throw new Error(
            'The price moved beyond the 0.50% tolerance since the quote was shown. Review the new quote and try again.',
          );
        } else {
          minimumSwapOut = protectedMinimum;
        }
        const latestBlock = await publicClient.getBlock({ blockTag: 'latest' });
        deadline = swapDeadline(latestBlock.timestamp);
      } catch (quoteError) {
        setError(`Could not prepare the order: ${errorMessage(quoteError)}`);
        return false;
      }

      return write(
        label,
        {
          address: target,
          abi: binaryMarketAbi,
          functionName: 'swap',
          args: [yesForNo, units, minimumSwapOut, deadline],
        },
        `Swapping ${inputSide} into ${side}`,
      );
    },
    [ensureAllowance, write],
  );

  const forgetPendingOrder = React.useCallback(() => {
    if (account) {
      clearPendingOrder(browserStorage(), xLayerTestnet.id, account);
    }
    setPendingOrder(undefined);
  }, [account]);

  /** The steps of buy(), run once its one-order-at-a-time checks pass. */
  const placeOrder = React.useCallback(
    async (
      target: Address,
      token: Address,
      side: TradeSide,
      amount: string,
    ) => {
      if (!account) return;
      let parsed: bigint;
      try {
        parsed = parsePositiveTokenAmount(amount);
      } catch (amountError) {
        setError(errorMessage(amountError));
        return;
      }
      const units = parsed;

      setFailedTransaction(undefined);
      await runBuy(units, {
        // Read now rather than from the snapshot, so a stale or skipped
        // ticket check cannot send a mint the balance can't cover.
        readBalance: async () =>
          (await publicClient.readContract({
            address: token,
            abi: mockUsdtAbi,
            functionName: 'balanceOf',
            args: [account],
          })) as bigint,
        quoteMinimumSwapOut: async () =>
          (await quoteOn(target, side, units)).minimumSwapOut,
        approveCollateral: () =>
          ensureAllowance('Approving mUSDT', token, mockUsdtAbi, target, units),
        mintPair: () =>
          write(
            `Buying ${side}`,
            {
              address: target,
              abi: binaryMarketAbi,
              functionName: 'mintSet',
              args: [units],
            },
            'Minting the YES + NO pair',
          ),
        swap: (minimumSwapOut) => swapInto(target, side, units, minimumSwapOut),
        recordPendingOrder: () => {
          const recorded: PendingOrder = {
            market: target,
            side,
            amount: units.toString(),
            createdAt: Date.now(),
          };
          savePendingOrder(
            browserStorage(),
            xLayerTestnet.id,
            account,
            recorded,
          );
          setPendingOrder(recorded);
        },
        forgetPendingOrder,
        fail: (message, cause) =>
          setError(cause ? `${message}: ${errorMessage(cause)}` : message),
      });
    },
    [account, ensureAllowance, forgetPendingOrder, swapInto, write],
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
      // One unfinished order at a time, whichever market it is on. Storage
      // is re-read so an order left unfinished in another tab counts too.
      if (orderInFlight.current) return;
      if (
        pendingOrder ||
        (account &&
          loadPendingOrder(browserStorage(), xLayerTestnet.id, account))
      ) {
        setError('Finish the unfinished order first.');
        return;
      }
      orderInFlight.current = true;
      await placeOrder(target, collateral, side, amount).finally(() => {
        orderInFlight.current = false;
      });
    },
    [account, collateral, pendingOrder, placeOrder],
  );

  const quoteSwitch = React.useCallback(
    async (
      from: TradeSide,
      amount: string,
    ): Promise<SwitchQuote | undefined> => {
      const target = marketRef.current;
      if (!target) return undefined;
      const to: TradeSide = from === 'YES' ? 'NO' : 'YES';
      // quoteOn(target, to, units) quotes sending `units` of `from` for `to`.
      const quote = await quoteOn(target, to, parsePositiveTokenAmount(amount));
      return {
        from,
        to,
        amountIn: quote.amountIn,
        amountOut: quote.swapOut,
        minimumOut: quote.minimumSwapOut,
        slippageBps: quote.slippageBps,
      };
    },
    [],
  );

  /**
   * Switch position: one swap from `from` into the other side. Nothing is
   * sold and no mUSDT is returned; the contract has no exit into mUSDT
   * before settlement. Held to the same one-action-at-a-time rule as buys.
   */
  const switchPosition = React.useCallback(
    async (from: TradeSide, amount: string, minimumOut: bigint) => {
      const target = marketRef.current;
      if (!target) {
        setError('Contracts not configured.');
        return;
      }
      if (orderInFlight.current) return;
      if (
        pendingOrder ||
        (account &&
          loadPendingOrder(browserStorage(), xLayerTestnet.id, account))
      ) {
        setError('Finish the unfinished order first.');
        return;
      }
      let units: bigint;
      try {
        units = parsePositiveTokenAmount(amount);
      } catch (amountError) {
        setError(errorMessage(amountError));
        return;
      }
      const to: TradeSide = from === 'YES' ? 'NO' : 'YES';
      orderInFlight.current = true;
      await swapInto(
        target,
        to,
        units,
        minimumOut,
        `Switching to ${to}`,
      ).finally(() => {
        orderInFlight.current = false;
      });
    },
    [account, pendingOrder, swapInto],
  );

  const finishPendingOrder = React.useCallback(async () => {
    const order = pendingOrder;
    if (!order) return;
    const swapped = await swapInto(
      getAddress(order.market),
      order.side,
      pendingOrderUnits(order),
    );
    if (swapped) forgetPendingOrder();
  }, [forgetPendingOrder, pendingOrder, swapInto]);

  const keepBothSides = React.useCallback(() => {
    forgetPendingOrder();
    setError(undefined);
  }, [forgetPendingOrder]);

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
      connecting,
      walletRpcFailed,
      lastTransaction,
      failedTransaction,
      connect,
      disconnect,
      refresh,
      mintCollateral,
      quoteBuy,
      buy,
      quoteSwitch,
      switchPosition,
      pendingOrder,
      finishPendingOrder,
      keepBothSides,
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
      connecting,
      walletRpcFailed,
      lastTransaction,
      failedTransaction,
      connect,
      disconnect,
      refresh,
      mintCollateral,
      quoteBuy,
      buy,
      quoteSwitch,
      switchPosition,
      pendingOrder,
      finishPendingOrder,
      keepBothSides,
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
