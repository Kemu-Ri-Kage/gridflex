import type { Abi, Address } from 'viem';

/**
 * A market's changing state. Every field comes from the same block: a
 * resolve() sets resolved and yesWon together, so reading them separately
 * could pair resolved = true with the pre-resolution yesWon = false from a
 * node a few blocks behind, and show a YES market as "Resolved · NO".
 */
export interface MarketLive {
  resolved: boolean;
  cancelled: boolean;
  yesWon: boolean;
  priceE18: bigint;
}

const LIVE_FIELDS = ['resolved', 'cancelled', 'yesWon', 'price'] as const;

export interface LiveRead {
  address: Address;
  abi: Abi;
  functionName: (typeof LIVE_FIELDS)[number];
}

/**
 * Runs every read as one Multicall3 aggregate: a single eth_call, answered
 * by a single node at a single block. Throws if any read fails, rather than
 * returning a partial snapshot.
 */
export type MulticallAll = (contracts: LiveRead[]) => Promise<readonly unknown[]>;

/** Live state for every market, all from one block. */
export async function readMarketsLive(
  multicall: MulticallAll,
  abi: Abi,
  addresses: readonly Address[],
): Promise<MarketLive[]> {
  if (addresses.length === 0) return [];
  const contracts = addresses.flatMap((address) =>
    LIVE_FIELDS.map((functionName) => ({ address, abi, functionName })),
  );
  const results = await multicall(contracts);
  if (results.length !== contracts.length) {
    throw new Error(`Expected ${contracts.length} results, got ${results.length}.`);
  }
  return addresses.map((_, i) => {
    const [resolved, cancelled, yesWon, priceE18] = results.slice(
      i * LIVE_FIELDS.length,
      (i + 1) * LIVE_FIELDS.length,
    );
    return {
      resolved: resolved as boolean,
      cancelled: cancelled as boolean,
      yesWon: yesWon as boolean,
      priceE18: priceE18 as bigint,
    };
  });
}

/**
 * Merge a new poll into the last one. Settlement is final on chain -
 * resolve() and cancel() both revert on a settled market - so a settled
 * state is kept even if a later poll is answered by a node that hasn't
 * reached the settling block yet. Otherwise that poll would briefly turn
 * "Resolved · YES" back into "Awaiting resolution".
 */
export function keepSettled(
  previous: Record<string, MarketLive>,
  next: Record<string, MarketLive>,
): Record<string, MarketLive> {
  const merged: Record<string, MarketLive> = { ...next };
  for (const [address, before] of Object.entries(previous)) {
    const after = next[address];
    if (after && (before.resolved || before.cancelled) && !(after.resolved || after.cancelled)) {
      merged[address] = before;
    }
  }
  return merged;
}
