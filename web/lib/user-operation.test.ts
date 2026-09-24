import assert from 'node:assert/strict';
import { test } from 'node:test';

import { keccak256, toBytes, type Hash, type Log } from 'viem';

import {
  findUserOperation,
  LOG_BLOCK_SPAN,
  nextLogWindow,
  USER_OPERATION_TOPIC,
  watchUserOperation,
  type LogReader,
} from './user-operation.ts';

const USER_OP = '0xb56bba880f611c83a345d21533614ddce412286869997d90549f41f6d1cef7d5' as Hash;
const BUNDLE_TX = '0x37a4db0cd59c51a9ed32ace53ff06476505bef26a2abb170dc000ed3af508da2' as Hash;
const SENDER = '0xa169e0ed94721bb7c47f5ff9e8ae2416ae44a4d5';

/** The UserOperationEvent OKX Wallet's mint produced on X Layer testnet, 24 Sep 2026, with `success` settable. */
function okxMintLog(success = true, entryPoint = '0x0000000071727de22e5e9d8baf0edac6f37da032'): Log {
  const flag = success ? '1' : '0';
  return {
    address: entryPoint as `0x${string}`,
    topics: [
      USER_OPERATION_TOPIC,
      USER_OP,
      `0x000000000000000000000000${SENDER.slice(2)}`,
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    ],
    data: `0x${'0'.repeat(63)}a${'0'.repeat(63)}${flag}${'0'.repeat(64)}${'0'.repeat(59)}40eca`,
    blockNumber: 41823577n,
    blockHash: '0x67deccf9f3f1c8596424cc68ae26182ed41e2280e9ce36a78cfb8fd3f328afdc',
    transactionHash: BUNDLE_TX,
    transactionIndex: 1,
    logIndex: 5,
    removed: false,
  };
}

void test('the event topic is the keccak of the UserOperationEvent signature', () => {
  assert.equal(
    keccak256(toBytes('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)')),
    USER_OPERATION_TOPIC,
  );
});

void test("OKX Wallet's user operation is found by its hash, with the bundle transaction and its success", () => {
  assert.deepEqual(findUserOperation([okxMintLog()], { userOpHash: USER_OP }), {
    transactionHash: BUNDLE_TX,
    success: true,
  });
  assert.deepEqual(findUserOperation([okxMintLog(false)], { userOpHash: USER_OP }), {
    transactionHash: BUNDLE_TX,
    success: false,
  });
  // by sender, for a wallet that returned the bundle's own hash
  assert.equal(findUserOperation([okxMintLog()], { sender: '0xA169E0ED94721BB7C47F5FF9E8AE2416AE44A4D5' })?.success, true);
});

void test('no match for another hash, another sender, or an address that is not an EntryPoint', () => {
  const other = `0x${'1'.repeat(64)}` as Hash;
  assert.equal(findUserOperation([okxMintLog()], { userOpHash: other }), undefined);
  assert.equal(findUserOperation([okxMintLog()], { sender: `0x${'2'.repeat(40)}` }), undefined);
  assert.equal(findUserOperation([okxMintLog(true, `0x${'3'.repeat(40)}`)], { userOpHash: USER_OP }), undefined);
  assert.equal(findUserOperation([], { userOpHash: USER_OP }), undefined);
  assert.equal(findUserOperation([okxMintLog()], {}), undefined);
});

void test('the search walks the chain a window of at most 100 blocks at a time', () => {
  assert.deepEqual(nextLogWindow(1000n, 1050n), { fromBlock: 1000n, toBlock: 1050n });
  assert.deepEqual(nextLogWindow(1000n, 5000n), { fromBlock: 1000n, toBlock: 1000n + LOG_BLOCK_SPAN - 1n });
  assert.equal(nextLogWindow(1001n, 1000n), null);
});

void test('the watcher searches forward from the send block, survives a failed read, and finds the operation', async () => {
  const ranges: string[] = [];
  let calls = 0;
  const reader: LogReader = {
    getBlockNumber: async () => 41823600n,
    getLogs: async ({ fromBlock, toBlock, topics }) => {
      calls += 1;
      assert.deepEqual(topics, [USER_OPERATION_TOPIC, USER_OP]);
      if (calls === 1) throw new Error('RPC dropped');
      ranges.push(`${fromBlock}-${toBlock}`);
      return fromBlock <= 41823577n && 41823577n <= toBlock ? [okxMintLog()] : [];
    },
  };
  const watch = watchUserOperation(reader, USER_OP, 41823400n, 1);
  const found = await watch.found;
  watch.stop();
  assert.deepEqual(found, { transactionHash: BUNDLE_TX, success: true });
  // the failed read retried the same first window
  assert.deepEqual(ranges, ['41823400-41823499', '41823500-41823599']);
});

void test('a stopped watcher makes no more reads', async () => {
  let calls = 0;
  const reader: LogReader = {
    getBlockNumber: async () => 10n,
    getLogs: async () => {
      calls += 1;
      return [];
    },
  };
  const watch = watchUserOperation(reader, USER_OP, 0n, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  watch.stop();
  const after = calls;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, after);
});
