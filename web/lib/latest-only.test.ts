import assert from 'node:assert/strict';
import { test } from 'node:test';

import { latestOnly } from './latest-only.ts';

void test('a read that finishes after a newer one started is dropped', async () => {
  const reads = latestOnly();
  const applied: string[] = [];
  let finishSlow: () => void = () => {};
  const read = async (label: string, wait: Promise<void>) => {
    const token = reads.begin();
    await wait;
    if (reads.isLatest(token)) applied.push(label);
  };
  // Started before the wallet connected, answered late.
  const before = read(
    'no wallet',
    new Promise<void>((resolve) => (finishSlow = resolve)),
  );
  // Started on connect, answered first.
  await read('connected wallet', Promise.resolve());
  finishSlow();
  await before;
  assert.deepEqual(applied, ['connected wallet']);
});

void test('a lone read applies', () => {
  const reads = latestOnly();
  const token = reads.begin();
  assert.equal(reads.isLatest(token), true);
});
