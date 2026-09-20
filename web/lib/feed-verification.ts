/**
 * Pure verification-state logic for the feed page's per-row indicator.
 *
 * shared/feed-spec.md §4: exactly one of four states per row
 * (VERIFIED / UNVERIFIED / LAST_VERIFIED / MISMATCH), driven entirely by a
 * live getReading() check compared against the committed metric file.
 *
 * Kept dependency-free (no React, no viem) so it can be unit-tested with
 * Node's built-in test runner without installing the rest of the workspace.
 */

export type VerificationStatus =
  | 'VERIFIED'
  | 'UNVERIFIED'
  | 'LAST_VERIFIED'
  | 'MISMATCH';

export interface VerificationState {
  status: VerificationStatus;
  /** epoch ms of the most recent check that matched, or null if none ever has. */
  lastVerifiedAt: number | null;
}

export const initialVerificationState: VerificationState = {
  status: 'UNVERIFIED',
  lastVerifiedAt: null,
};

export interface CommittedReading {
  value: number | string | bigint;
  sourceHash: string;
}

export interface ChainReading {
  value: bigint;
  sourceHash: string;
}

function normalizeHash(hash: string): string {
  return hash.toLowerCase().replace(/^0x/, '');
}

/** shared/feed-spec.md §4: value and sourceHash must both match exactly. */
export function readingsMatch(
  committed: CommittedReading,
  chain: ChainReading,
): boolean {
  return (
    BigInt(committed.value) === chain.value &&
    normalizeHash(committed.sourceHash) === normalizeHash(chain.sourceHash)
  );
}

export type CheckOutcome =
  | { kind: 'match'; at: number }
  | { kind: 'mismatch'; at: number }
  | { kind: 'failure' };

/**
 * shared/feed-spec.md §4/§6: apply one check's outcome to the current state.
 *
 * MISMATCH is a result, not a failure - a later 'failure' outcome (a retry
 * that timed out) must never downgrade it to LAST_VERIFIED, and reaching
 * MISMATCH is not itself retried (see verifyOnce below). Only a fresh
 * successful check - a further match or mismatch - can move a row out of
 * MISMATCH.
 */
export function applyCheckOutcome(
  state: VerificationState,
  outcome: CheckOutcome,
): VerificationState {
  switch (outcome.kind) {
    case 'match':
      return { status: 'VERIFIED', lastVerifiedAt: outcome.at };
    case 'mismatch':
      return { status: 'MISMATCH', lastVerifiedAt: state.lastVerifiedAt };
    case 'failure':
      if (state.status === 'MISMATCH') return state;
      if (state.lastVerifiedAt !== null) {
        return { status: 'LAST_VERIFIED', lastVerifiedAt: state.lastVerifiedAt };
      }
      return { status: 'UNVERIFIED', lastVerifiedAt: null };
  }
}

function outcomeFrom(
  committed: CommittedReading,
  chain: ChainReading,
  now: number,
): CheckOutcome {
  return readingsMatch(committed, chain)
    ? { kind: 'match', at: now }
    : { kind: 'mismatch', at: now };
}

/**
 * Runs one live check, retrying once on a call that fails to *complete*
 * (network/timeout) only - shared/feed-spec.md §6. A call that completes and
 * disagrees with the committed file returns 'mismatch' immediately and is
 * never retried; only a thrown error triggers the single retry.
 */
export async function verifyOnce(
  committed: CommittedReading,
  fetchChainReading: () => Promise<ChainReading>,
  now: () => number = Date.now,
  maxAttempts = 2,
): Promise<CheckOutcome> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const chain = await fetchChainReading();
      return outcomeFrom(committed, chain, now());
    } catch (error) {
      lastError = error;
    }
  }
  void lastError;
  return { kind: 'failure' };
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}
