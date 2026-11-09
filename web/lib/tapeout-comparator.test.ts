import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bitsOf,
  buildComparator,
  decodeOutput,
  evaluate,
  inputBytes,
  settlementInputs,
  toHex,
} from './tapeout-comparator.ts';

const run = (
  netlist: ReturnType<typeof buildComparator>,
  a: number,
  b: number,
  bits: number,
) => {
  const inputs = [
    ...Array.from({ length: bits }, (_, i) => (a >> i) & 1),
    ...Array.from({ length: bits }, (_, i) => (b >> i) & 1),
  ];
  return evaluate(netlist, inputs);
};

void test('the 16-bit comparator has 126 gates and needs 130 transistors', () => {
  const n = buildComparator();
  assert.equal(n.nIn, 32);
  assert.equal(n.nOut, 2);
  assert.equal(n.gates, 6 + 15 * 8);
  assert.equal(n.transistors, 130);
  assert.equal(n.bytes.length, n.gates * 7);
});

void test('an 8-bit comparator is right for every one of the 65,536 pairs', () => {
  const n = buildComparator(8);
  for (let a = 0; a < 256; a++) {
    for (let b = 0; b < 256; b++) {
      const [gt, lt] = run(n, a, b, 8);
      if (gt !== Number(a > b) || lt !== Number(a < b))
        assert.fail(`a=${a} b=${b}: got ${gt}${lt}`);
    }
  }
});

void test('the 16-bit comparator is right at the edges and on 50,000 deterministic pairs', () => {
  const n = buildComparator();
  const pairs: Array<[number, number]> = [
    [0, 0],
    [0, 1],
    [1, 0],
    [65_535, 65_535],
    [65_535, 0],
    [0, 65_535],
    [32_768, 32_767],
    [32_767, 32_768],
    [9_423, 9_500],
    [9_500, 9_423],
    [9_500, 9_500],
  ];
  let x = 123_456_789;
  const rand = () => {
    x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0;
    return x >>> 16;
  };
  for (let i = 0; i < 50_000; i++) {
    const a = rand();
    pairs.push([a, i % 5 === 0 ? a : rand()]); // every fifth pair equal
  }
  for (const [a, b] of pairs) {
    const [gt, lt] = run(n, a, b, 16);
    if (gt !== Number(a > b) || lt !== Number(a < b))
      assert.fail(`a=${a} b=${b}: got ${gt}${lt}`);
  }
});

void test('inputs go in as two little-endian uint16s, the way eval packs bits', () => {
  assert.equal(toHex(inputBytes(0x1234, 0xabcd)), '0x3412cdab');
  const bits = bitsOf(inputBytes(5, 3), 32);
  assert.deepEqual(bits.slice(0, 3), [1, 0, 1]); // A = 5
  assert.deepEqual(bits.slice(16, 18), [1, 1]); // B = 3
  assert.throws(() => inputBytes(70_000, 0));
});

void test('an option settles through the circuit as the contract does', () => {
  const band = { floorCents: -5000, capCents: 30_000 };
  const n = buildComparator();
  const check = (price: number, strike: number) => {
    const { a, b } = settlementInputs(price, strike, band);
    const out = evaluate(n, bitsOf(inputBytes(a, b), 32));
    return decodeOutput(out[0] | (out[1] << 1));
  };
  assert.deepEqual(check(5200, 4500), { callPays: true, putPays: false }); // $52 vs a $45 strike
  assert.deepEqual(check(4000, 4500), { callPays: false, putPays: true });
  assert.deepEqual(check(4500, 4500), { callPays: false, putPays: false }); // at the strike nothing pays
  assert.deepEqual(check(-20_000, -4500), { callPays: false, putPays: true }); // -$200 clamps to -$50
  assert.deepEqual(check(900_000, 29_500), { callPays: true, putPays: false }); // $9,000 clamps to $300
});

void test('the simulator reads a real circuit from X Layer the same way', () => {
  // netlist(1) on the OrderGuard processor, read from X Layer mainnet:
  // NAND(2,3), NAND(4,4)... starts 0x00 000002 000003 00 000004 000004
  const bytes = Uint8Array.from([
    0x00, 0, 0, 2, 0, 0, 3, 0x00, 0, 0, 4, 0, 0, 4,
  ]);
  assert.deepEqual(evaluate({ bytes, nIn: 2, nOut: 1 }, [1, 1]), [1]); // NOT(NAND(1,1)) = 1
  assert.deepEqual(evaluate({ bytes, nIn: 2, nOut: 1 }, [1, 0]), [0]);
});
