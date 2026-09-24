import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  connectionAlreadyPendingMessage,
  isUnknownChainError,
  isWalletRpcFailure,
  requestAlreadyPendingMessage,
  walletErrorMessage,
  walletRequestAlreadyPending,
  walletUserRejected,
} from './wallet-errors.ts';

function wrapped(cause: object) {
  return Object.assign(new Error('Transaction failed.'), { cause });
}

void test('a wallet whose saved RPC fails is an RPC failure', () => {
  assert.equal(
    isWalletRpcFailure(
      wrapped({ code: -32603, message: 'Internal JSON-RPC error.' }),
    ),
    true,
  );
  assert.equal(
    isWalletRpcFailure(
      wrapped({
        code: -32603,
        message: 'Internal JSON-RPC error.',
        data: { message: 'Failed to fetch' },
      }),
    ),
    true,
  );
  assert.equal(
    isWalletRpcFailure(
      wrapped({
        code: -32002,
        message: 'RPC endpoint returned too many errors',
      }),
    ),
    true,
  );
  assert.equal(isWalletRpcFailure(new Error('Request timed out')), true);
});

void test('the user declining is never an RPC failure', () => {
  assert.equal(
    isWalletRpcFailure(
      wrapped({ code: 4001, message: 'User rejected the request.' }),
    ),
    false,
  );
});

void test('a contract revert reported through -32603 is not an RPC failure', () => {
  assert.equal(
    isWalletRpcFailure(
      wrapped({
        code: -32603,
        message: 'Internal JSON-RPC error.',
        data: { message: 'execution reverted: TradingClosed()' },
      }),
    ),
    false,
  );
});

void test('ordinary errors are not RPC failures', () => {
  assert.equal(
    isWalletRpcFailure(new Error('Amount must be positive.')),
    false,
  );
  assert.equal(isWalletRpcFailure(undefined), false);
  assert.equal(isWalletRpcFailure('boom'), false);
});

// The real error chains viem builds when a wallet's request fails, from a
// wallet stub (no network): what the provider's write() actually catches.
async function viemWriteError(walletError: object): Promise<unknown> {
  const { createWalletClient, custom, parseAbi } = await import('viem');
  const client = createWalletClient({
    account: '0xD95Bd9f3E641974515B53adE252AD43e7cB28059',
    chain: {
      id: 1952,
      name: 'X Layer Testnet',
      nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
      rpcUrls: { default: { http: ['http://127.0.0.1:1'] } },
    },
    transport: custom({
      async request({ method }: { method: string }) {
        if (method === 'eth_chainId') return '0x7a0';
        throw Object.assign(
          new Error(String((walletError as { message?: string }).message)),
          walletError,
        );
      },
    }),
  });
  try {
    await client.writeContract({
      address: '0xb22A449cdEfA3C4D226Ff69fd87d95f4FaadE604',
      abi: parseAbi(['function approve(address,uint256) returns (bool)']),
      functionName: 'approve',
      args: ['0xb22A449cdEfA3C4D226Ff69fd87d95f4FaadE604', 1n],
    });
  } catch (error) {
    return error;
  }
  throw new Error('expected the write to fail');
}

void test('viem rewrapping a dead wallet RPC as a "revert" is still an RPC failure', async () => {
  const error = await viemWriteError({
    code: -32603,
    message: 'Internal JSON-RPC error.',
    data: { message: 'Failed to fetch' },
  });
  assert.match(String((error as Error).message), /reverted/);
  assert.equal(isWalletRpcFailure(error), true);
});

void test('a real revert through the wallet is not an RPC failure', async () => {
  const error = await viemWriteError({
    code: -32603,
    message: 'Internal JSON-RPC error.',
    data: {
      code: 3,
      message: 'execution reverted',
      data: '0xe2c865df', // TradingClosed()
    },
  });
  assert.equal(isWalletRpcFailure(error), false);
});

void test('the user rejecting in the wallet is not an RPC failure', async () => {
  const error = await viemWriteError({
    code: 4001,
    message: 'User rejected the request.',
  });
  assert.equal(isWalletRpcFailure(error), false);
});

// MetaMask uses -32002 both for a failing RPC and for a prompt already
// open for this site (@metamask/approval-controller); only the wording
// tells them apart.
const PENDING_PERMISSIONS = {
  code: -32002,
  message:
    "Request of type 'wallet_requestPermissions' already pending for origin https://gridflex.pages.dev. Please wait.",
};

void test('an already-pending permissions prompt is not an RPC failure', () => {
  assert.equal(isWalletRpcFailure(PENDING_PERMISSIONS), false);
  assert.equal(isWalletRpcFailure(wrapped(PENDING_PERMISSIONS)), false);
  assert.equal(
    walletRequestAlreadyPending(wrapped(PENDING_PERMISSIONS), 'MetaMask'),
    'A wallet connection request is already open. Open MetaMask and complete or reject it.',
  );
});

void test("older MetaMask's already-processing eth_requestAccounts is a pending connection", () => {
  const error = {
    code: -32002,
    message: 'Already processing eth_requestAccounts. Please wait.',
  };
  assert.equal(isWalletRpcFailure(error), false);
  assert.equal(
    walletRequestAlreadyPending(error),
    connectionAlreadyPendingMessage(),
  );
});

void test('other prompt types already pending get the general message', () => {
  for (const type of [
    'wallet_switchEthereumChain',
    'wallet_addEthereumChain',
  ]) {
    const error = {
      code: -32002,
      message: `Request of type '${type}' already pending for origin https://gridflex.pages.dev. Please wait.`,
    };
    assert.equal(isWalletRpcFailure(error), false);
    assert.equal(
      walletRequestAlreadyPending(error),
      requestAlreadyPendingMessage(),
    );
  }
});

void test('a -32002 without the pending wording is still an RPC failure', () => {
  const error = { code: -32002, message: 'Resource unavailable' };
  assert.equal(walletRequestAlreadyPending(error), undefined);
  assert.equal(isWalletRpcFailure(error), true);
});

void test("a pending prompt is recognised through viem's wrapping of a write", async () => {
  const error = await viemWriteError(PENDING_PERMISSIONS);
  assert.equal(isWalletRpcFailure(error), false);
  assert.equal(
    walletRequestAlreadyPending(error),
    connectionAlreadyPendingMessage(),
  );
});

void test("the wallet's own message is shown, with its code", () => {
  assert.equal(
    walletErrorMessage({
      code: -32002,
      message: 'Request already pending, please wait',
    }),
    'Request already pending, please wait (wallet error -32002)',
  );
  assert.equal(
    walletErrorMessage(new Error('Request timed out')),
    'Request timed out',
  );
  assert.equal(walletErrorMessage({ code: 4001 }), undefined);
  assert.equal(walletErrorMessage(undefined), undefined);
});

void test("a viem error shows the wallet's words, not viem's wrapper", async () => {
  const error = await viemWriteError({
    code: -32603,
    message: 'Internal JSON-RPC error.',
  });
  assert.equal(
    walletErrorMessage(error),
    'Internal JSON-RPC error. (wallet error -32603)',
  );
});

void test('an unknown chain is recognised, including wrapped in -32603', () => {
  assert.equal(
    isUnknownChainError({ code: 4902, message: 'Unrecognized chain ID' }),
    true,
  );
  assert.equal(
    isUnknownChainError({
      code: -32603,
      message: 'Unrecognized chain ID "0x7a0".',
      data: { originalError: { code: 4902 } },
    }),
    true,
  );
  assert.equal(
    isUnknownChainError({ code: -32603, message: 'Internal JSON-RPC error.' }),
    false,
  );
  assert.equal(
    isUnknownChainError({ code: 4001, message: 'User rejected the request.' }),
    false,
  );
});

void test('the pending message names the wallet in use, never MetaMask by default', () => {
  assert.equal(
    walletRequestAlreadyPending(PENDING_PERMISSIONS, 'OKX Wallet'),
    'A wallet connection request is already open. Open OKX Wallet and complete or reject it.',
  );
  const unnamed = walletRequestAlreadyPending(PENDING_PERMISSIONS);
  assert.equal(
    unnamed,
    'A wallet connection request is already open. Open your wallet and complete or reject it.',
  );
  assert.doesNotMatch(unnamed ?? '', /MetaMask/);
});

void test("OKX Wallet's refusal of a connect is a user rejection, not an RPC failure", async () => {
  // Measured in Chrome, 24 Sep 2026: OKX's answer to eth_requestAccounts.
  const okxDenied = {
    code: 4001,
    message: 'Request Signature: User denied request signature.',
  };
  assert.equal(walletUserRejected(okxDenied), true);
  assert.equal(walletUserRejected(wrapped(okxDenied)), true);
  assert.equal(isWalletRpcFailure(okxDenied), false);
  assert.equal(walletRequestAlreadyPending(okxDenied), undefined);
  assert.equal(walletUserRejected(PENDING_PERMISSIONS), false);
});
