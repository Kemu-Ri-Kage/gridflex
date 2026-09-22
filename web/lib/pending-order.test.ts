import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clearPendingOrder,
  loadPendingOrder,
  orderGate,
  pendingOrderKey,
  savePendingOrder,
  type PendingOrder,
  type PendingOrderStorage,
} from './pending-order.ts';

const CHAIN = 1952;
const ACCOUNT = '0x00000000000000000000000000000000000000Aa';
const OTHER_ACCOUNT = '0x00000000000000000000000000000000000000Bb';
const MARKET_A = '0xb1FaDd618FFC37E26bf75143E6C852d6D3992F94';
const MARKET_B = '0x204Ef0871892c52b7Abf00AC4755333c5e7F73af';

function memoryStorage(): PendingOrderStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function order(overrides: Partial<PendingOrder> = {}): PendingOrder {
  return {
    market: MARKET_A,
    side: 'YES',
    amount: '100000000',
    createdAt: 1_790_000_000_000,
    ...overrides,
  };
}

void test('switching markets with a pending set blocks the new market and points back', () => {
  const storage = memoryStorage();
  assert.equal(savePendingOrder(storage, CHAIN, ACCOUNT, order()), true);

  // The user moves to market B: the record is untouched and still blocks.
  const pending = loadPendingOrder(storage, CHAIN, ACCOUNT);
  assert.deepEqual(pending, order());
  assert.deepEqual(orderGate(pending, MARKET_B), {
    blocked: true,
    elsewhere: true,
  });
  // Back on market A it still blocks, now as this market's own order.
  assert.deepEqual(orderGate(pending, MARKET_A.toLowerCase()), {
    blocked: true,
    elsewhere: false,
  });
  // No selection at all is also blocked.
  assert.equal(orderGate(pending, undefined).blocked, true);
});

void test('a second order cannot replace the first one', () => {
  const storage = memoryStorage();
  savePendingOrder(storage, CHAIN, ACCOUNT, order());

  const second = order({ market: MARKET_B, side: 'NO', createdAt: 1 });
  assert.equal(savePendingOrder(storage, CHAIN, ACCOUNT, second), false);
  assert.deepEqual(loadPendingOrder(storage, CHAIN, ACCOUNT), order());
  // Re-saving the same record is harmless.
  assert.equal(savePendingOrder(storage, CHAIN, ACCOUNT, order()), true);
});

void test('the pending order is restored after a page reload', () => {
  const storage = memoryStorage();
  savePendingOrder(storage, CHAIN, ACCOUNT, order({ side: 'NO' }));

  // A reload is a fresh read of the same storage, nothing held in memory.
  const restored = loadPendingOrder(storage, CHAIN, ACCOUNT);
  assert.deepEqual(restored, order({ side: 'NO' }));
  assert.equal(orderGate(restored, MARKET_B).blocked, true);
});

void test('records are scoped by chain and wallet', () => {
  const storage = memoryStorage();
  savePendingOrder(storage, CHAIN, ACCOUNT, order());

  assert.equal(loadPendingOrder(storage, CHAIN, OTHER_ACCOUNT), undefined);
  assert.equal(loadPendingOrder(storage, 196, ACCOUNT), undefined);
  // Address case does not matter.
  assert.deepEqual(
    loadPendingOrder(storage, CHAIN, ACCOUNT.toLowerCase()),
    order(),
  );
});

void test('only market, side, amount and timestamp are stored', () => {
  const storage = memoryStorage();
  savePendingOrder(storage, CHAIN, ACCOUNT, {
    ...order(),
    secret: 'x',
  } as PendingOrder);
  const stored = JSON.parse(
    storage.data.get(pendingOrderKey(CHAIN, ACCOUNT)) ?? '{}',
  );
  assert.deepEqual(Object.keys(stored).sort(), [
    'amount',
    'createdAt',
    'market',
    'side',
  ]);
});

void test('clearing removes the record and unblocks ordering', () => {
  const storage = memoryStorage();
  savePendingOrder(storage, CHAIN, ACCOUNT, order());
  clearPendingOrder(storage, CHAIN, ACCOUNT);
  const pending = loadPendingOrder(storage, CHAIN, ACCOUNT);
  assert.equal(pending, undefined);
  assert.deepEqual(orderGate(pending, MARKET_A), {
    blocked: false,
    elsewhere: false,
  });
  // A new order may now be recorded.
  assert.equal(
    savePendingOrder(storage, CHAIN, ACCOUNT, order({ market: MARKET_B })),
    true,
  );
});

void test('malformed records and unavailable storage read as no record', () => {
  const storage = memoryStorage();
  const key = pendingOrderKey(CHAIN, ACCOUNT);
  for (const raw of [
    'not json',
    '{}',
    JSON.stringify({ ...order(), market: '0x123' }),
    JSON.stringify({ ...order(), side: 'MAYBE' }),
    JSON.stringify({ ...order(), amount: '0' }),
    JSON.stringify({ ...order(), amount: '1.5' }),
  ]) {
    storage.data.set(key, raw);
    assert.equal(loadPendingOrder(storage, CHAIN, ACCOUNT), undefined);
  }

  const throwing: PendingOrderStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(loadPendingOrder(throwing, CHAIN, ACCOUNT), undefined);
  assert.equal(savePendingOrder(throwing, CHAIN, ACCOUNT, order()), false);
  assert.doesNotThrow(() => clearPendingOrder(throwing, CHAIN, ACCOUNT));
  assert.equal(loadPendingOrder(undefined, CHAIN, ACCOUNT), undefined);
});
