import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findFillRound, runKeeper, type PendingItem } from './keeper.ts';

// rounds 1..6 published at 100, 400, 700, 1000, 1300, 1600
const published = (r: number) => Promise.resolve(r * 300 - 200);

void test('the fill round is the first round published strictly after the request', async () => {
  assert.equal(await findFillRound(450, 6, published), 3); // 700 is the first after 450
  assert.equal(await findFillRound(400, 6, published), 3); // a round in the same second never counts
  assert.equal(await findFillRound(50, 6, published), 1);
  assert.equal(await findFillRound(1600, 6, published), null); // not published yet
  assert.equal(await findFillRound(10, 0, published), null);
});

void test('the keeper executes each ready item at its own fill round and retries failures', async () => {
  const sent: Array<[string, number]> = [];
  const log: string[] = [];
  const items: PendingItem[] = [
    { kind: 'order', id: 7, createdAt: 450 },
    { kind: 'pool', id: 2, createdAt: 1000 },
    { kind: 'order', id: 8, createdAt: 1650 }, // after the latest round
  ];
  const deps = {
    pending: async () => items,
    latestRoundId: async () => 6,
    publishedAt: published,
    execute: async (item: PendingItem, round: number) => {
      if (item.kind === 'pool')
        throw new Error('FreeLiquidityTooLow(5, 4)\nmore detail');
      sent.push([`${item.kind} ${item.id}`, round]);
      return '0xtx';
    },
    log: (line: string) => log.push(line),
  };

  assert.equal(await runKeeper({ ...deps, dryRun: true }), 2);
  assert.equal(sent.length, 0);

  assert.equal(await runKeeper({ ...deps, dryRun: false }), 1);
  assert.deepEqual(sent, [['order 7', 3]]);
  assert.match(
    log.join('\n'),
    /pool 2: not executed yet \(FreeLiquidityTooLow\(5, 4\)\)/,
  );
  assert.match(log.join('\n'), /order 8: waiting for its fill round/);
});

void test('a long queue is worked through a batch at a time', async () => {
  const items = Array.from({ length: 25 }, (_, i) => ({
    kind: 'order' as const,
    id: i + 1,
    createdAt: 50,
  }));
  const log: string[] = [];
  const done = await runKeeper(
    {
      pending: async () => items,
      latestRoundId: async () => 6,
      publishedAt: published,
      execute: async () => '0xtx',
      log: (line) => log.push(line),
      dryRun: false,
    },
    20,
  );
  assert.equal(done, 20);
  assert.match(log.at(-1)!, /5 more left for the next run/);
});
