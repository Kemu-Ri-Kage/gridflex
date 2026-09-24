/**
 * Smart-contract accounts, such as OKX Wallet's social-login accounts,
 * don't send transactions themselves: the wallet hands each call to a
 * bundler as an ERC-4337 user operation, and the bundler includes it in
 * its own transaction to an EntryPoint contract. Such a wallet may answer
 * eth_sendTransaction with the user operation's hash, which no node can
 * return a receipt for, so waiting on that hash alone waits forever even
 * though the call went through (seen with OKX Wallet on X Layer testnet,
 * 24 Sep 2026: tx 0x37a4db0c…da2 carried user operation 0xb56bba88…f7d5).
 *
 * The EntryPoint logs every user operation it runs, keyed by that hash and
 * with whether the call inside succeeded - the bundle transaction itself
 * succeeds either way. This module finds that log. Chain access is
 * injected, so it is tested directly.
 */
import { parseAbiItem, parseEventLogs, type Address, type Hash, type Log } from 'viem';

/** The ERC-4337 EntryPoints: v0.7 (what OKX Wallet used above) and v0.6. */
export const ENTRY_POINTS: readonly Address[] = [
  '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
];

/** Identical in v0.6 and v0.7. */
export const userOperationEvent = parseAbiItem(
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
);

/** X Layer's public RPC answers eth_getLogs over at most 100 blocks. */
export const LOG_BLOCK_SPAN = 100n;

export interface UserOperationFound {
  /** The bundle transaction that carried it. */
  transactionHash: Hash;
  /** Whether the account's own call succeeded inside the bundle. */
  success: boolean;
}

/** The next block range to search from `cursor`, or null once past `latest`. */
export function nextLogWindow(
  cursor: bigint,
  latest: bigint,
): { fromBlock: bigint; toBlock: bigint } | null {
  if (cursor > latest) return null;
  const end = cursor + LOG_BLOCK_SPAN - 1n;
  return { fromBlock: cursor, toBlock: end < latest ? end : latest };
}

/**
 * The user operation in a set of logs whose hash is `userOpHash`, or whose
 * sender is `sender` when no hash is given: a receipt from a wallet that
 * returned the bundle's own hash carries its account's operation.
 */
export function findUserOperation(
  logs: readonly Log[],
  match: { userOpHash?: Hash; sender?: Address },
): UserOperationFound | undefined {
  const events = parseEventLogs({ abi: [userOperationEvent], logs: [...logs], strict: false });
  const event = events.find(({ address, args }) => {
    if (!ENTRY_POINTS.some((entryPoint) => entryPoint.toLowerCase() === address.toLowerCase())) return false;
    if (match.userOpHash) return args.userOpHash?.toLowerCase() === match.userOpHash.toLowerCase();
    return Boolean(match.sender) && args.sender?.toLowerCase() === match.sender?.toLowerCase();
  });
  if (!event?.transactionHash || event.args.success === undefined) return undefined;
  return { transactionHash: event.transactionHash, success: event.args.success };
}

/** The chain reads watchUserOperation needs. */
export interface LogReader {
  getBlockNumber(): Promise<bigint>;
  getLogs(range: { address: Address[]; fromBlock: bigint; toBlock: bigint; topics: (Hash | null)[] }): Promise<Log[]>;
}

/** keccak256 of the event's signature: topic 0 of every UserOperationEvent. */
export const USER_OPERATION_TOPIC =
  '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f' as const;

/**
 * Search the EntryPoints, from `fromBlock` onwards, for the user operation
 * whose hash is `userOpHash`, a window of blocks at a time, until it is
 * found or stop() is called. A failed read is retried on the next tick.
 */
export function watchUserOperation(
  reader: LogReader,
  userOpHash: Hash,
  fromBlock: bigint,
  intervalMs = 2_000,
): { found: Promise<UserOperationFound>; stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const found = new Promise<UserOperationFound>((resolve) => {
    let cursor = fromBlock;
    const tick = async () => {
      if (stopped) return;
      try {
        const latest = await reader.getBlockNumber();
        for (let window = nextLogWindow(cursor, latest); window && !stopped; window = nextLogWindow(cursor, latest)) {
          const logs = await reader.getLogs({
            address: [...ENTRY_POINTS],
            fromBlock: window.fromBlock,
            toBlock: window.toBlock,
            topics: [USER_OPERATION_TOPIC, userOpHash],
          });
          const hit = findUserOperation(logs, { userOpHash });
          if (hit) {
            resolve(hit);
            return;
          }
          cursor = window.toBlock + 1n;
        }
      } catch {
        // A dropped read: try the same window again next tick.
      }
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
    };
    void tick();
  });
  return {
    found,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
