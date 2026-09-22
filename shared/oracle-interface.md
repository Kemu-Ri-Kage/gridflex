# GRIDFLEX oracle interface

**Status: FROZEN as of 2026-09-11.**

This is the frozen boundary between the Python data pipeline (this repo)
and the Solidity oracle + market contracts on X Layer
testnet (`contracts/`). Neither side changes this interface
— field names, types, ordering, or the `metricId` hashes below — without
telling the other first. If a change is needed, raise it, agree it, then
bump the date at the top of this file.

This document does not itself contain or generate code. The struct and
function signatures below are the agreed shape; each side implements them
independently (Python writes the JSON files that match this shape, Solidity
implements the contract that matches this shape).

---

## The `Reading` struct

```solidity
struct Reading {
    bytes32 metricId;
    uint32  dayKey;              // YYYYMMDD, e.g. 20260908 - NOT a timestamp
    uint64  marketDayStartUtc;
    uint64  marketDayEndUtc;
    int256  value;               // signed: basis goes negative
    bytes32 sourceHash;
    uint64  publishedAt;
    bool    finalized;
}
```

### Field-by-field: where each value comes from

Every field below traces to a specific key in the metric JSON files written
by `write_metric()` in `fetch_ercot.py`, e.g.
`data/metrics/ERCOT_HBNORTH_DA_AVG__2026-09-08.json`.

| Struct field | Source | Notes |
|---|---|---|
| `metricId` | Not a JSON field. Derived: `keccak256(bytes(metricJson["metricId"]))`, i.e. `keccak256("ERCOT_HBNORTH_DA_AVG")` etc. | See "metricId hashes" below. The JSON field `metricId` holds the *string* (`"ERCOT_HBNORTH_DA_AVG"`); the oracle stores the *hash* of that string. |
| `dayKey` | JSON `dayKey` | Already `uint32`-shaped (`YYYYMMDD` int, e.g. `20250910`). Copied as-is, no conversion. |
| `marketDayStartUtc` | JSON `marketDayStartUtc` | Already a Unix timestamp (seconds), fits `uint64`. Copied as-is. |
| `marketDayEndUtc` | JSON `marketDayEndUtc` | Same as above. |
| `value` | JSON `value` | Already the signed integer to settle on (USD/MWh × 100 for both contract metrics). Copied as-is — no re-scaling, no re-rounding. |
| `sourceHash` | JSON `sourceHash` | Hex string in the JSON (e.g. `"1b3ead66..."`); on-chain it's the raw `bytes32` of that hex value, not a re-hash of it. |
| `publishedAt` | Not a JSON field. Set by the oracle/publisher at submission time (`block.timestamp` when `submitReading` is called), not read from the metric file. | JSON has `computedAt` (when Python computed the value) — that is a different moment from `publishedAt` (when it was submitted on-chain) and is not itself part of this interface. |
| `finalized` | Not a JSON field. Set by the oracle in response to `finalize()`, independent of anything Python writes. | See "finalize" below — this is a separate on-chain step after submission, not something the pipeline decides. |

`marketDay` (the ISO date string, e.g. `"2025-09-10"`) and `sourceFiles`
(the ordered list of raw cache filenames) are in the JSON for humans and
auditors but are **not** part of the on-chain struct — they're too large
and unnecessary for settlement logic. Anyone verifying a reading
independently reads them from the published metric file, not from chain
state.

`hoursUsed`, `westAvg`/`northAvg`, `intervalsUsed`, `loadWeights` (the
metric-specific "extra" fields — see `shared/metrics.md`) are likewise
off-chain-only audit context, not part of the struct.

---

## Why `dayKey` is `uint32 YYYYMMDD`, not a timestamp

This was already resolved inside the pipeline (see `shared/metrics.md`,
"Why there's no `periodStart`/`periodEnd`") and the
same reasoning is why it must stay this shape across the chain boundary
too — this is exactly the kind of decision someone reverses by "simplifying"
the oracle to store a `uint64` Unix timestamp instead, so it's spelled out
here.

A timestamp is an *instant*; a market day is a *calendar date in Central
time*. Those are different things, and a field that looks like the former
while meaning the latter is a trap: whoever converts it back to a date to
find out "which day is this" gets the timezone-shifted answer, not the
Central date the value is actually for. That's not hypothetical — it's
exactly what the prior `periodStart` field did on every single row (see
`shared/metrics.md` for the reproduced bug: 8 September 2026's `periodStart`
converted back to 7 September Central).

`dayKey` sidesteps the whole class of bug by not being an instant at all.
`20260908` is not "a time that happens to fall on September 8" — it *is*
"September 8," encoded as a plain integer with no timezone attached. There
is nothing to convert, so there is nothing that can shift by a day.
Solidity and Python parse it identically (string/integer slicing, not
timezone arithmetic), which is not true of a Unix timestamp — converting
that correctly requires both sides to agree on Central time's UTC offset,
including on the two DST transition days each year, which is precisely
where the old scheme broke.

`marketDayStartUtc`/`marketDayEndUtc` still carry the true UTC instants
(for anything that genuinely needs an instant — e.g. an oracle staleness
check, or a UI countdown), but they are explicitly *not* the identifier a
market looks up by. `dayKey` is.

## Why `value` is `int256`, not `uint256`

`ERCOT_WEST_NORTH_DA_BASIS` is `HB_WEST` day-ahead price minus `HB_NORTH`
day-ahead price, and it regularly goes negative — West Texas has enough
wind and solar that it clears cheaper than North on many days (see
`shared/metrics.md`, "Contract metric: `ERCOT_WEST_NORTH_DA_BASIS`": the
sample day above is `+474` meaning West was *more* expensive, but negative
days are the common case, not an edge case). A `uint256` cannot represent
that at all — someone reverses this to `uint256` for "gas savings" or
because "prices are usually positive," and the basis contract becomes
unable to settle on the majority of days where the interesting, tradeable
number is negative. `int256` is required by the metric itself, not a
defensive choice.

`ERCOT_HBNORTH_DA_AVG` is currently always positive in practice, but it
shares the same struct field as `value`'s type is per-struct, not
per-metric — there is one `Reading` shape for every `metricId`, so the
type has to accommodate the metric that needs it.

---

## `metricId` hashes

`metricId` is `keccak256` of the metric name string exactly as it appears
in the JSON `metricId` field (UTF-8 bytes, no padding, no `0x` prefix
hashed — the `0x` below is the standard display prefix on the *output*).

```
keccak256("ERCOT_HBNORTH_DA_AVG")
  = 0x7a88591e3d45a73e2e1fe40bdeb1f25fceeb286320608175e92d9060460ba419

keccak256("ERCOT_WEST_NORTH_DA_BASIS")
  = 0xcb4f1bcdaae09e42edc7ae603695a05155e75a2276e8b4efee3e40234ffee342

keccak256("ERCOT_LOAD_WEIGHTED_DA_INDEX")
  = 0x62589a5650da7f168bd6755b3f56ba1b9c64f4da434135185580234ab00895fb

keccak256("ERCOT_HBWEST_NEG_INTERVALS")
  = 0xd04e1fb6492148dfad0ad3378978132856861235b695cf1be2c6673b1c128a2c
```

Verified against the standard Ethereum test vector
(`keccak256("") = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470`)
using the same hash routine before hashing the four metric names above.

Per `shared/metrics.md`, only the first two are contract
metrics — the only two `metricId`s a market contract should ever be
constructed against. The latter two are feed-only: the oracle can store
readings for them (there's no reason not to, since it's the same
`submitReading` call), but no market contract should reference their
`metricId` as its settlement source.

---

## Functions

```solidity
function submitReading(
    bytes32 metricId,
    uint32  dayKey,
    uint64  marketDayStartUtc,
    uint64  marketDayEndUtc,
    int256  value,
    bytes32 sourceHash
) external onlyReporter;

function finalize(bytes32 metricId, uint32 dayKey) external;

function getReading(bytes32 metricId, uint32 dayKey)
    external view returns (Reading memory);

function isFinal(bytes32 metricId, uint32 dayKey)
    external view returns (bool);
```

`submitReading` takes every struct field except `publishedAt` and
`finalized`, which the oracle sets itself (`publishedAt = block.timestamp`
at submission; `finalized` starts `false`). The five value-bearing
arguments map 1:1 to the five corresponding JSON keys as in the table
above — the publisher (whatever script/service calls this on the contracts side)
reads a metric JSON file and passes its `dayKey`, `marketDayStartUtc`,
`marketDayEndUtc`, `value`, and `sourceHash` straight through, plus
`metricId` computed as `keccak256(json["metricId"])`.

`finalize` is a separate step from `submitReading` — a reading can be
submitted and readable via `getReading` before it's finalized, but
`isFinal` returns `false` until `finalize` is called. This interface
doesn't prescribe *when* finalization happens (that's market/dispute-window
design, on the contracts side); it only fixes that submission and finalization are
two distinct calls, not one.

---

## Events

```solidity
event ReadingSubmitted(bytes32 indexed metricId, uint32 indexed dayKey, int256 value, bytes32 sourceHash);
event ReadingFinalized(bytes32 indexed metricId, uint32 indexed dayKey);
```

Both index on `(metricId, dayKey)` — the same composite key used to look up
a `Reading` via `getReading`/`isFinal` — so anyone watching the chain can
filter to one metric's history, or one specific day's reading, without
scanning full event logs.

---

## Ownership note

This file lives in `shared/` because both sides read it. The Python
pipeline and Solidity contracts are maintained as separate components,
so changing this interface is a two-person decision regardless of which
person authors the diff.
