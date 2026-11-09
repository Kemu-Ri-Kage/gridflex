/**
 * GRIDFLEX's settlement rule as a TapeOut circuit (OKX X Layer TapeOut
 * Accelerate): a NAND-gate comparator that answers, for an option, "does the
 * settlement price pay a call?" (price above the strike) and "does it pay a
 * put?" (price below the strike).
 *
 * TapeOut netlist format (X Layer, as published by TapeOut builders):
 * - signal 0 is constant 0, signal 1 is constant 1, input i is signal 2 + i,
 *   gate i's output is signal 2 + nIn + i; gates only read lower signals;
 * - a NAND gate is 7 bytes: 0x00, then two 3-byte big-endian signal numbers;
 * - the last nOut signals are the outputs; the contract adds two buffer NANDs
 *   per output at tape-out, so it costs gates + 2 x nOut transistors;
 * - eval(id, inputs) packs input bits from bit 0 of byte 0 upward, and
 *   returns the outputs packed the same way.
 *
 * Inputs: A (16 bits, the settlement price) then B (16 bits, the strike),
 * least significant bit first, so the input bytes are A and B as two
 * little-endian uint16s. Prices enter as cents above the band floor:
 * A = clamp(price, floor, cap) - floor, B = strike - floor (0 to 35,000 for
 * the -$50 to $300 band, inside 16 bits).
 * Outputs: bit 0 = A > B (a call pays), bit 1 = B > A (a put pays).
 *
 * The comparator ripples from the least significant bit: with
 * gt = a AND NOT b and lt = NOT a AND b,
 *   G_i = gt_i OR (G_{i-1} AND NOT lt_i)     L_i = lt_i OR (L_{i-1} AND NOT gt_i)
 * which is 8 NAND gates a bit (2 fewer for bit 0, where G and L start at 0).
 * No React here, so it is tested directly.
 */

export const BITS = 16;

export interface Netlist {
  bytes: Uint8Array;
  nIn: number;
  nOut: number;
  /** NAND gates in the netlist. */
  gates: number;
  /** Transistors to mint before tape-out: gates plus two buffers per output. */
  transistors: number;
}

class Builder {
  private bytes: number[] = [];
  private next: number;
  readonly nIn: number;
  gates = 0;

  constructor(nIn: number) {
    this.nIn = nIn;
    this.next = 2 + nIn;
  }

  input(i: number): number {
    return 2 + i;
  }

  nand(a: number, b: number): number {
    if (a >= this.next || b >= this.next)
      throw new Error('a gate may only read earlier signals');
    this.bytes.push(
      0x00,
      (a >> 16) & 0xff,
      (a >> 8) & 0xff,
      a & 0xff,
      (b >> 16) & 0xff,
      (b >> 8) & 0xff,
      b & 0xff,
    );
    this.gates++;
    return this.next++;
  }

  build(nOut: number): Netlist {
    return {
      bytes: Uint8Array.from(this.bytes),
      nIn: this.nIn,
      nOut,
      gates: this.gates,
      transistors: this.gates + 2 * nOut,
    };
  }
}

/** The comparator netlist for `bits`-bit A and B (16 for GRIDFLEX; smaller for exhaustive tests). */
export function buildComparator(bits = BITS): Netlist {
  const b = new Builder(2 * bits);
  let G = -1; // no signal yet: G_{-1} = 0
  let L = -1;
  let lastG = 0;
  let lastL = 0;
  for (let i = 0; i < bits; i++) {
    const ai = b.input(i);
    const bi = b.input(bits + i);
    const nb = b.nand(bi, bi); // NOT b
    const na = b.nand(ai, ai); // NOT a
    const notGt = b.nand(ai, nb); // NOT (a AND NOT b)
    const notLt = b.nand(na, bi); // NOT (NOT a AND b)
    if (i === 0) {
      // G_0 = gt_0 = NOT notGt; L_0 = lt_0 = NOT notLt (NAND with constant 1)
      G = b.nand(notGt, 1);
      L = b.nand(notLt, 1);
    } else {
      const zG = b.nand(G, notLt); // NOT (G_{i-1} AND NOT lt)
      const zL = b.nand(L, notGt); // NOT (L_{i-1} AND NOT gt)
      // the last bit's two gates must be the circuit's last two signals, G then L
      G = b.nand(notGt, zG);
      L = b.nand(notLt, zL);
    }
    lastG = G;
    lastL = L;
  }
  if (lastL !== lastG + 1)
    throw new Error('outputs must be the last two signals, G then L');
  return b.build(2);
}

/** Runs a netlist the way the contract's eval does, for checking before any tape-out. */
export function evaluate(
  netlist: Pick<Netlist, 'bytes' | 'nIn' | 'nOut'>,
  inputBits: readonly number[],
): number[] {
  const { bytes, nIn, nOut } = netlist;
  const signals: number[] = [
    0,
    1,
    ...inputBits.slice(0, nIn).map((v) => (v ? 1 : 0)),
  ];
  if (signals.length !== 2 + nIn) throw new Error('wrong number of inputs');
  for (let p = 0; p < bytes.length;) {
    const op = bytes[p];
    if (op !== 0x00)
      throw new Error(`only NAND gates are expected here, got opcode ${op}`);
    const a = (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    const b = (bytes[p + 4] << 16) | (bytes[p + 5] << 8) | bytes[p + 6];
    if (a >= signals.length || b >= signals.length)
      throw new Error('NAND: future signal');
    signals.push(signals[a] & signals[b] ? 0 : 1);
    p += 7;
  }
  return signals.slice(-nOut);
}

/** The eval input bytes for A and B: two little-endian uint16s. */
export function inputBytes(a: number, b: number): Uint8Array {
  if (
    !Number.isInteger(a) ||
    !Number.isInteger(b) ||
    a < 0 ||
    b < 0 ||
    a > 0xffff ||
    b > 0xffff
  ) {
    throw new Error('A and B must be whole numbers from 0 to 65,535');
  }
  return Uint8Array.from([a & 0xff, a >> 8, b & 0xff, b >> 8]);
}

export function bitsOf(bytes: Uint8Array, count: number): number[] {
  return Array.from(
    { length: count },
    (_, i) => (bytes[i >> 3] >> (i & 7)) & 1,
  );
}

/** A and B for an option: cents above the band floor, the price clamped into the band. */
export function settlementInputs(
  priceCents: number,
  strikeCents: number,
  band: { floorCents: number; capCents: number },
): { a: number; b: number } {
  const clamped = Math.min(
    Math.max(priceCents, band.floorCents),
    band.capCents,
  );
  return { a: clamped - band.floorCents, b: strikeCents - band.floorCents };
}

/** Decodes eval's output byte: which side pays. */
export function decodeOutput(byte: number): {
  callPays: boolean;
  putPays: boolean;
} {
  return { callPays: (byte & 1) === 1, putPays: (byte & 2) === 2 };
}

export function toHex(bytes: Uint8Array): `0x${string}` {
  return `0x${[...bytes].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}
