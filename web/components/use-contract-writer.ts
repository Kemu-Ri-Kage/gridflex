'use client';

/**
 * Sends a transaction to any GRIDFLEX contract through the wallet the user
 * connected with the site's Connect button (components/web3-provider.tsx),
 * for screens whose contracts the provider does not know (futures,
 * options). It finds that wallet again by its EIP-6963 id, so the provider
 * itself is unchanged.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createWalletClient,
  custom,
  type Abi,
  type Address,
  type Hash,
} from 'viem';

import { useWeb3 } from '@/components/web3-provider';
import { xLayerTestnet } from '@/lib/contracts';
import { chainClient, erc20Abi } from '@/lib/derivatives';
import {
  watchWallets,
  type DiscoveredWallet,
  type DiscoveryWindow,
} from '@/lib/wallet-discovery';

export interface WriteRequest {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/user (rejected|denied)/i.test(text))
    return 'You declined in the wallet.';
  const reason =
    /reverted with the following reason:\s*(.+)/.exec(text)?.[1] ??
    /Error: ([A-Za-z]+\(.*?\))/.exec(text)?.[1];
  return reason
    ? `The contract refused: ${reason}`
    : text.split('\n')[0].slice(0, 160);
}

export function useContractWriter() {
  const { account, wallet, connect } = useWeb3();
  const wallets = useRef<DiscoveredWallet[]>([]);
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [lastHash, setLastHash] = useState<Hash>();

  useEffect(() => {
    const watcher = watchWallets(
      window as unknown as DiscoveryWindow,
      (list) => {
        wallets.current = list;
      },
    );
    return () => watcher.stop();
  }, []);

  /** Sends one transaction and waits for it; resolves whether it confirmed. */
  const send = useCallback(
    async (label: string, request: WriteRequest): Promise<boolean> => {
      const provider = wallets.current.find(
        (w) => w.info.id === wallet?.id,
      )?.provider;
      if (!account || !provider) {
        setError('Connect a wallet first.');
        return false;
      }
      setPending(label);
      setError(undefined);
      try {
        const client = createWalletClient({
          account,
          chain: xLayerTestnet,
          transport: custom(provider),
        });
        const hash = await client.writeContract({
          ...request,
          account,
          chain: xLayerTestnet,
        } as Parameters<typeof client.writeContract>[0]);
        setLastHash(hash);
        const receipt = await chainClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success')
          throw new Error('The transaction reverted.');
        return true;
      } catch (e) {
        setError(shortError(e));
        return false;
      } finally {
        setPending(undefined);
      }
    },
    [account, wallet],
  );

  /** Approves `spender` for at least `amount` of `token`, only if it is not already. */
  const ensureAllowance = useCallback(
    async (
      token: Address,
      spender: Address,
      amount: bigint,
    ): Promise<boolean> => {
      if (!account) {
        setError('Connect a wallet first.');
        return false;
      }
      const current = await chainClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account, spender],
      });
      if (current >= amount) return true;
      return send('Approving mUSDT', {
        address: token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, amount],
      });
    },
    [account, send],
  );

  return {
    account,
    connect,
    send,
    ensureAllowance,
    pending,
    error,
    lastHash,
    clearError: () => setError(undefined),
  };
}
