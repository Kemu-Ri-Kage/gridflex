import assert from 'node:assert/strict';
import { test } from 'node:test';

import { singleFlight } from './single-flight.ts';

/** A wallet stub whose connect prompt stays open until answered. */
function wallet() {
  const requests: string[] = [];
  let answer: (accounts: string[]) => void = () => {};
  let refuse: (error: Error) => void = () => {};
  const request = ({ method }: { method: string }) => {
    requests.push(method);
    return new Promise<string[]>((resolve, reject) => {
      answer = resolve;
      refuse = reject;
    });
  };
  return {
    requests,
    request,
    answer: (accounts: string[]) => answer(accounts),
    refuse: (error: Error) => refuse(error),
  };
}

function guardedConnect(stub: ReturnType<typeof wallet>) {
  return singleFlight(async () => {
    await stub.request({ method: 'eth_requestAccounts' });
  });
}

void test('a rapid double click on Connect sends one eth_requestAccounts', async () => {
  const stub = wallet();
  const connect = guardedConnect(stub);
  const first = connect.run();
  const second = connect.run(); // same tick, before any await resolves
  const third = connect.run();
  assert.equal(connect.running(), true);
  assert.deepEqual(stub.requests, ['eth_requestAccounts']);
  stub.answer(['0xabc']);
  await Promise.all([first, second, third]);
  assert.deepEqual(stub.requests, ['eth_requestAccounts']);
});

void test('the lock clears after success, so Connect works again', async () => {
  const stub = wallet();
  const connect = guardedConnect(stub);
  const first = connect.run();
  stub.answer(['0xabc']);
  await first;
  assert.equal(connect.running(), false);
  void connect.run();
  assert.equal(stub.requests.length, 2);
});

void test('the lock clears after the user rejects, and after a failure', async () => {
  for (const error of [
    Object.assign(new Error('User rejected the request.'), { code: 4001 }),
    Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 }),
  ]) {
    const stub = wallet();
    const connect = guardedConnect(stub);
    const first = connect.run();
    stub.refuse(error);
    await assert.rejects(first);
    assert.equal(connect.running(), false);
    void connect.run().catch(() => {});
    assert.equal(stub.requests.length, 2);
  }
});
