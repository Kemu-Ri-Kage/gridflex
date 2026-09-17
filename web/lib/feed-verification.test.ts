import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyCheckOutcome,
  formatElapsed,
  initialVerificationState,
  readingsMatch,
  verifyOnce,
  type ChainReading,
  type CommittedReading,
} from './feed-verification.ts';

const committed: CommittedReading = { value: 3957, sourceHash: '11'.repeat(32) };
const matchingChain: ChainReading = { value: 3957n, sourceHash: '11'.repeat(32) };
const mismatchingChain: ChainReading = { value: 9999n, sourceHash: '11'.repeat(32) };

// --- readingsMatch -----------------------------------------------------

test('readingsMatch: matches across value types and hash 0x/case variation', () => {
  assert.equal(
    readingsMatch({ value: '3957', sourceHash: '0x' + '11'.repeat(32) }, matchingChain),
    true,
  );
  assert.equal(
    readingsMatch({ value: 3957n, sourceHash: ('11'.repeat(32)).toUpperCase() }, matchingChain),
    true,
  );
});

test('readingsMatch: a value difference is not a match', () => {
  assert.equal(readingsMatch(committed, mismatchingChain), false);
});

test('readingsMatch: a sourceHash-only difference is not a match either', () => {
  assert.equal(
    readingsMatch(committed, { value: 3957n, sourceHash: '22'.repeat(32) }),
    false,
  );
});

// --- the four states, via applyCheckOutcome -----------------------------

test('state 1/4 - UNVERIFIED is the initial state', () => {
  assert.equal(initialVerificationState.status, 'UNVERIFIED');
  assert.equal(initialVerificationState.lastVerifiedAt, null);
});

test('state 1/4 - UNVERIFIED persists across a failure with no prior success', () => {
  const next = applyCheckOutcome(initialVerificationState, { kind: 'failure' });
  assert.equal(next.status, 'UNVERIFIED');
  assert.equal(next.lastVerifiedAt, null);
});

test('state 2/4 - VERIFIED after a matching check', () => {
  const next = applyCheckOutcome(initialVerificationState, { kind: 'match', at: 1000 });
  assert.equal(next.status, 'VERIFIED');
  assert.equal(next.lastVerifiedAt, 1000);
});

test('state 3/4 - LAST_VERIFIED after a prior match is followed by a failed check', () => {
  const verified = applyCheckOutcome(initialVerificationState, { kind: 'match', at: 1000 });
  const next = applyCheckOutcome(verified, { kind: 'failure' });
  assert.equal(next.status, 'LAST_VERIFIED');
  assert.equal(next.lastVerifiedAt, 1000); // the last successful timestamp is preserved
});

test('state 4/4 - MISMATCH after a completed check that disagrees with the committed file', () => {
  const next = applyCheckOutcome(initialVerificationState, { kind: 'mismatch', at: 2000 });
  assert.equal(next.status, 'MISMATCH');
});

// --- the correction that mattered: MISMATCH must never degrade or be retried away ---

test('MISMATCH is never downgraded to LAST_VERIFIED by a later failed check', () => {
  const verified = applyCheckOutcome(initialVerificationState, { kind: 'match', at: 1000 });
  const mismatched = applyCheckOutcome(verified, { kind: 'mismatch', at: 2000 });
  assert.equal(mismatched.status, 'MISMATCH');

  // A subsequent RPC timeout/failure must not launder this into LAST_VERIFIED.
  const afterFailure = applyCheckOutcome(mismatched, { kind: 'failure' });
  assert.equal(afterFailure.status, 'MISMATCH');
  assert.equal(afterFailure.lastVerifiedAt, mismatched.lastVerifiedAt);
});

test('MISMATCH persists through repeated subsequent failures, not just one', () => {
  let state = applyCheckOutcome(initialVerificationState, { kind: 'mismatch', at: 500 });
  for (let i = 0; i < 5; i++) {
    state = applyCheckOutcome(state, { kind: 'failure' });
  }
  assert.equal(state.status, 'MISMATCH');
});

test('only a fresh successful check can move a row out of MISMATCH', () => {
  const mismatched = applyCheckOutcome(initialVerificationState, { kind: 'mismatch', at: 500 });
  const resolved = applyCheckOutcome(mismatched, { kind: 'match', at: 999 });
  assert.equal(resolved.status, 'VERIFIED');
  assert.equal(resolved.lastVerifiedAt, 999);
});

// --- verifyOnce: retry-on-failure only, mismatch is never retried -------

test('verifyOnce retries exactly once on a thrown error, then succeeds', async () => {
  let calls = 0;
  const fetchChainReading = async () => {
    calls += 1;
    if (calls === 1) throw new Error('RPC timeout');
    return matchingChain;
  };
  const outcome = await verifyOnce(committed, fetchChainReading, () => 42);
  assert.deepEqual(outcome, { kind: 'match', at: 42 });
  assert.equal(calls, 2);
});

test('verifyOnce gives up as a failure after the retry also fails, not more', async () => {
  let calls = 0;
  const fetchChainReading = async () => {
    calls += 1;
    throw new Error('RPC down');
  };
  const outcome = await verifyOnce(committed, fetchChainReading);
  assert.deepEqual(outcome, { kind: 'failure' });
  assert.equal(calls, 2); // one attempt + exactly one retry, never a third
});

test('verifyOnce returns mismatch on the first successful-but-disagreeing call, without any retry', async () => {
  let calls = 0;
  const fetchChainReading = async () => {
    calls += 1;
    return mismatchingChain;
  };
  const outcome = await verifyOnce(committed, fetchChainReading, () => 7);
  assert.deepEqual(outcome, { kind: 'mismatch', at: 7 });
  assert.equal(calls, 1); // a completed disagreeing call is never retried
});

// --- formatElapsed --------------------------------------------------------

test('formatElapsed renders seconds, minutes, and hours sensibly', () => {
  assert.equal(formatElapsed(12_000), '12s');
  assert.equal(formatElapsed(90_000), '2m');
  assert.equal(formatElapsed(3 * 60 * 60 * 1000), '3h');
});
