# GRIDFLEX on TapeOut

For the OKX X Layer TapeOut Accelerate hackathon (deadline 7 Dec 2026), GRIDFLEX's
option settlement rule runs as a TapeOut circuit on X Layer mainnet: a 16-bit NAND-gate
comparator (`lib/tapeout-comparator.ts`) that tells, for a day's settlement price and a
strike, whether a call pays (price above the strike) or a put pays (price below).

| | |
| --- | --- |
| Inputs | 32 bits: A = settlement price, B = strike, each in cents above the -$50 band floor, as two little-endian uint16s (`inputBytes`) |
| Outputs | bit 0 = call pays (A > B), bit 1 = put pays (B > A); both 0 at the strike |
| Size | 126 NAND gates, 130 transistors with TapeOut's output buffers |
| Checked | every pair for an 8-bit version (65,536), 50,000 pairs and the edges for 16 bits (`lib/tapeout-comparator.test.ts`) |

Anyone can check a settlement for free with the circuit's `eval(id, inputs)`.

## Putting it on X Layer mainnet

`node tapeout/deploy.ts` (from `web/`) is a dry run: it reads TapeOut's fees and prints the
plan. `--live` sends, in order: approve the BEM deploy fee, `createCPU` (a GRIDFLEX
processor, mint price 0), approve the BEM protocol fee, mint 130 NAND, `tapeout`, then it
finds the circuit and checks `eval` against the simulation, and saves `tapeout/deployed.json`.

What the wallet needs (fees read on 9 Nov 2026): **0.11 BEM** (0.1 deploy fee + 0.01
protocol fee; BEM is TapeOut's token, `0x60e62Efa9405d6873C5deaBD4E6CC91c25363952`) and
about **0.003 OKB** (0.0013 tape-out fee plus gas).

The key: the person deploying sets it in their own terminal for that one command and
never puts it in a file or a chat:

```
cd web
TAPEOUT_PRIVATE_KEY=0x... node tapeout/deploy.ts --live
```

## Rehearsal (free)

The whole sequence was run on a local fork of X Layer mainnet with anvil's public test
account (`--rehearsal` funds it with the BEM fee from a mainnet holder, on the fork only):

```
anvil --fork-url https://rpc.xlayer.tech --port 8547
node tapeout/deploy.ts --live --rehearsal --rpc http://127.0.0.1:8547
```

On 9 Nov 2026 it created the processor, minted 130 NAND, taped out circuit 1, and all five
`eval` checks matched (call pays / put pays / neither), for 0.00297 OKB including gas.

Notes from the rehearsal: `createCPU` is not payable (the fee is BEM via `transferFrom`),
the factory's event is not the `CPUCreated` older scripts expect (the script finds the new
contracts by probing `TAPEOUT_FEE()`), and newer processors take the protocol fee in BEM.
