# GRIDFLEX publish/finalize spec

**Status: spec only, no implementation yet.** This document specifies two
scripts — `publish.py` (writes readings to `GridOracle`) and `finalize.py`
(locks them in) — to the level of detail needed to implement them without
further design decisions. It contains no Python code, only pseudocode and
prose. It was produced by interviewing the pipeline owner in detail; every
decision below has a stated rationale so it doesn't need to be re-derived
later.

This spec assumes `shared/oracle-interface.md` (the frozen struct/function/
event boundary) and `contracts/src/GridOracle.sol` (the actual deployed
contract) as ground truth. Two facts below were **verified live against the
deployed contract**, not assumed from `.env.example` defaults:

```
$ cast call 0x970cefFC0e75bCa245F3337715992ad520A4D561 "disputeWindow()(uint64)" --rpc-url https://testrpc.xlayer.tech/terigon
3600
$ cast call 0x970cefFC0e75bCa245F3337715992ad520A4D561 "reporter()(address)" --rpc-url https://testrpc.xlayer.tech/terigon
0x27Aad02480f1DC01ebCb53fd7321a4629BCbe902
```

`disputeWindow` is 3600 seconds (1 hour). `reporter` is David's deployer
address, matching `shared/addresses.json`. `chainId` via `eth_chainId`
returns `0x7a0` = 1952. The oracle address holds real contract bytecode
(confirmed via `eth_getCode`), with the reporter address baked in as an
immutable constant.

---

## 1. Roles and key custody

**This is the organizing fact for the whole spec: `publish.py` and
`finalize.py` are run by two different people, on two different machines,
using two different keys, and neither script ever needs both.**

| | Who | Key | Needs |
|---|---|---|---|
| `publish.py --live` | **David** | The oracle's `reporter` key (immutable, already deployed as `0x27Aad0...`) | Reporter permission (`onlyReporter` on `submitReading`) |
| `finalize.py --live` | **The pipeline owner** (Platon) | A separate wallet, held only by them | Testnet OKB for gas only — `finalize()` has no access control |
| `finalize.py --verify` | Anyone, from any machine | None | Nothing — pure read-only view calls |

Consequences that follow directly from this split, each enforced elsewhere
in this spec:

- `REPORTER_PRIVATE_KEY` (or an equivalent keystore) is **never** present in
  the pipeline owner's `.env`, never committed, never referenced as if it
  might be. `publish.py` is written and owned by the pipeline owner but is
  never executed by them with `--live`.
- The **ledger file** (`data/publish-ledger.json`, §4) is the hand-off
  artifact between the two people. David runs `publish.py --live`, commits
  and pushes the resulting ledger; the pipeline owner pulls it before
  running `finalize.py`. The ledger is **git-committed, not gitignored** —
  it contains only public testnet data (tx hashes, values, addresses), and
  it has to survive the hand-off.
- `finalize.py`'s key is unrelated to the reporter key entirely — a wallet
  with no special contract permission, funded from the X Layer faucet like
  any other testnet wallet.
- `--verify` needs no wallet at all, specifically so the demo can be sanity
  checked from any machine (e.g. in Singapore) with nothing but an RPC URL.

---

## 2. `publish.py`

### 2.1 What it does

Reads `data/metrics/*.json`, validates each file, and for every metric/day
not already correctly reflected on-chain, calls `submitReading` on
`GridOracle` (address from `shared/addresses.json`, never hardcoded
elsewhere) with the six arguments the frozen interface defines:

```
submitReading(metricId, dayKey, marketDayStartUtc, marketDayEndUtc, value, sourceHash)
```

mapped 1:1 from the JSON file exactly as `shared/oracle-interface.md`
specifies: `metricId = keccak256(bytes(json["metricId"]))`, `dayKey`,
`marketDayStartUtc`, `marketDayEndUtc`, `value`, and `sourceHash` (parsed
from its hex string into raw `bytes32`) all copied as-is, no conversion,
no rescaling.

### 2.2 Metrics and scope in this backfill

All four metrics with a frozen `metricId` hash in `shared/oracle-interface.md`
are in scope:

- `ERCOT_HBNORTH_DA_AVG` (contract metric)
- `ERCOT_WEST_NORTH_DA_BASIS` (contract metric)
- `ERCOT_LOAD_WEIGHTED_DA_INDEX` (feed metric)
- `ERCOT_HBWEST_NEG_INTERVALS` (feed metric)

**`ERCOT_FUELMIX_<FUEL>` files are excluded, structurally, not by choice of
default.** No `metricId` hash exists for fuel mix anywhere in the frozen
interface — there is nothing for `publish.py` to submit it as. If fuel mix
is ever wanted on-chain, that requires extending `shared/oracle-interface.md`
first (a two-person decision per its own ownership note), not a flag on this
script.

Rationale for publishing all four rather than only the two contract metrics:
the two feed metrics are described in `shared/oracle-interface.md` as
storable ("the oracle can store readings for them... there's no reason not
to") and in the README as "published, shown on the site." If the site's feed
display is meant to read from the chain rather than straight from local
JSON, the feed metrics need to actually be there. The claim "everything you
see is verifiably onchain" is only true if this is done.

Default date range for the initial backfill: **everything currently in
`data/metrics/`** for the four in-scope metrics — the full year, ~1,448
files (363 + 363 + 363 + 359). Estimated cost, measured against the live
endpoint: **~50–95 minutes wall-clock**, **~0.000004 OKB per submission**
(~0.006 OKB total for the full backfill) at the measured ~0.02 gwei gas
price and ~180–220k gas per `submitReading` call. This is a one-time run,
not something repeated regularly — subsequent runs only publish new files
that show up in `data/metrics/`.

### 2.3 CLI surface

```
publish.py [--metric NAME] [--start YYYYMMDD | --days N] [--end YYYYMMDD]
           [--limit N] [--live] [--check] [--reconcile]
```

- `--metric NAME` — restrict to one metric (repeatable for more than one).
  Default: all four in-scope metrics.
- `--start`/`--end` or `--days` — restrict by `dayKey`. Default: everything
  in `data/metrics/`.
- `--limit N` — cap the number of readings submitted in this run (useful for
  a small test run before committing to the full backfill).
- `--live` — actually send transactions. **Without it, the script only
  prints what it would submit and sends nothing** (see §2.5).
- `--check` — run preflight checks only (§3.2) and exit. Sends nothing,
  costs nothing.
- `--reconcile` — for every reading the ledger believes is already
  published, re-read it from chain (`getReading`) and compare `value`/
  `sourceHash`. Report any divergence loudly (exit non-zero) rather than
  silently trusting the ledger. Does not submit anything itself.

With no flags at all, and without `--live`, running `publish.py` is always
safe: it reads files, validates them, checks the ledger, and prints a plan.

### 2.4 Idempotency and the ledger

**Required, testable property: running `publish.py` twice in a row with no
new metric files produces zero transactions on the second run.** This is
the single most important behavioral guarantee in this spec — `GridOracle`
does not reject a duplicate `submitReading` for an unfinalized reading, it
*replaces* it and restarts the dispute window (see `contracts/src/GridOracle.sol`,
`submitReading`: `if (current.finalized) revert ...` is the *only* rejection
path — anything not yet finalized is silently overwritten). A publisher that
doesn't guard against this can prevent its own readings from ever
accumulating enough age to finalize.

**Mechanism: a local ledger file, `data/publish-ledger.json`**, one entry
per `(metricId, dayKey)`:

```json
{
  "ERCOT_HBNORTH_DA_AVG:20260908": {
    "metricId": "ERCOT_HBNORTH_DA_AVG",
    "dayKey": 20260908,
    "value": 3957,
    "sourceHash": "75999d01...",
    "nonce": 42,
    "txHash": "0x...",
    "blockNumber": 12345678,
    "status": "confirmed",
    "submittedAt": "2026-09-14T12:00:00Z"
  }
}
```

`nonce` is required, not optional — §2.6's crash-recovery logic compares this
against the wallet's on-chain nonce to detect an in-flight transaction, and
has nothing to compare against if it isn't recorded.

`status` is one of `submitted` (sent, receipt not yet seen — only exists
transiently or after a crash, see §2.6), `confirmed` (receipt seen,
`status == 1`), `finalized` (learned either from an `EXPECTED` revert during
a later run, or from `--reconcile`/`finalize.py` observing `isFinal() ==
true`).

Before submitting a reading, `publish.py`:
1. Computes the file's `(metricId, dayKey)` key.
2. If the ledger has an entry for that key with matching `value` and
   `sourceHash` and `status` in `{confirmed, finalized}` — **skip, no RPC
   call at all.** This is what makes a re-run fast: no chain reads needed
   for readings it already knows about.
3. If the ledger has no entry — submit.
4. If the ledger has an entry and `value` differs from the file — this is a
   genuine correction. Submit the new value. (`GridOracle` allows this —
   replacing an unfinalized reading is the documented, intended behavior for
   corrections; it is only a *bug* when the replacement is accidental, which
   this skip logic exists to prevent.)
5. If the ledger has an entry with the **same `value` but a different
   `sourceHash`** — **do not resubmit.** Log a prominent warning and skip.
   See "Named failure mode: sourceHash drift without a value change," below,
   for why this case must never trigger a resubmission.

**Named failure mode: `sourceHash` drift without a value change.**
`fetch_ercot.py` chunks its raw-data cache by calendar month, starting at
the literal requested `--days` start date, not the 1st of the month (see
`shared/metrics.md`, "Shared limitations"). Two pipeline runs with different
`--days` windows produce different, overlapping-but-not-identical chunk
boundaries for whichever month their windows begin in — so the same market
day's `sourceHash` (which commits to the exact chunk files used) can change
between runs even though the computed `value` is identical. This was
observed directly on 2026-09-10. If step 4 above were written to resubmit on
*any* difference (value or hash), this failure mode would cause `publish.py`
to resubmit a reading whose value never changed — silently resetting its
dispute window for no reason, which is precisely the bug this entire design
exists to prevent. **Do not "fix" this later by making rule 5 resubmit on
hash drift** — the hash is expected to vary across runs by the pipeline's
own documented chunking behavior; only a `value` change is a real
correction.

**`--reconcile` exists because the ledger can drift from truth** — it's a
local cache, and the reporter key holder (David) can call `submitReading`
directly, outside `publish.py`, for any reason (testing, a manual fix). Storing
`value`/`sourceHash` in the ledger (not just a boolean "published" flag) is
what makes `--reconcile` able to detect a **divergence**, not just a missing
entry: for every ledger row, re-read `getReading()` and compare. Any
mismatch is reported and the process exits non-zero. Run this on demand —
before the demo, or whenever the ledger's authority is in doubt — not on
every normal run, since it costs one `getReading` call per already-known
reading (~1,448 extra reads for the full set).

### 2.5 Dry-run by default, `--live` requires confirmation

A bare `python publish.py` (no `--live`) never sends a transaction. It
reads and validates files, checks the ledger, and prints exactly what it
would do: how many readings would be submitted, how many skipped (already
published), how many skipped (invalid file, with reasons), and an estimated
duration/cost for the live run.

`--live` requires an explicit interactive confirmation before sending
anything. The banner must show:

```
GRIDFLEX publish.py — LIVE MODE

  Chain ID:          1952
  Oracle contract:    0x970cefFC0e75bCa245F3337715992ad520A4D561
  Signer (reporter):  0x27Aad02480f1DC01ebCb53fd7321a4629BCbe902
  Wallet balance:      X.XXXX OKB
  Readings to submit:  N
  Estimated duration:  ~M minutes
  Estimated cost:      ~C OKB

Type "yes" to continue:
```

The signer address shown is always the address *derived* from whichever key
source is configured (§5) — never the raw key or keystore password. This
banner is the deliberate, single moment where an hour-long job actually
starts; there is no `--yes`/`--force` flag to skip it.

### 2.6 Resume after an interrupted run

If `publish.py` is killed mid-run (crash, laptop sleep, RPC drop), a
transaction may have been sent to the node with no receipt ever observed
locally — an ambiguous state: did it land or not?

**This recovery depends on a specific ledger write order, stated explicitly
because §2.4 doesn't otherwise fix it: the ledger entry is written with
`status: "submitted"` — including the `nonce` that's about to be used —
*before* the transaction is sent, then updated to `status: "confirmed"`
(with `txHash`/`blockNumber`) only after the receipt comes back.** Writing
the entry after the receipt instead would mean a crash between "sent" and
"receipt observed" leaves no local record at all, and the recovery logic
below would have nothing to compare against — the ledger would simply look
like that reading was never attempted.

On startup, before doing anything else: compare the wallet's actual
on-chain pending nonce (`eth_getTransactionCount(address, "pending")`)
against the ledger's highest-recorded nonce for a `submitted`-but-not-yet-
`confirmed` entry. If they disagree, that specific transaction is in
flight — poll for its receipt (apply the same status-check logic as §2.7)
before resuming the run normally.

This was chosen over the simpler "just resend on restart" specifically
because a resend, landing on a reading that turns out to have actually gone
through, would trigger exactly the dispute-window-reset bug this whole
design exists to prevent — on the one reading that happened to be mid-flight
when the process died.

**Named recovery behaviour: a `submitted` row whose nonce was never
broadcast.** If the wallet's on-chain pending nonce is still at or below a
`submitted` entry's recorded `nonce`, that transaction never actually left
the process — the crash happened before (or during) the RPC send itself, so
the nonce was never consumed on-chain. In that specific case it is safe to
delete the ledger row outright: nothing to reconcile against, and the
reading resubmits cleanly with a fresh nonce on the next run. This is the
one case in §2.6 that resolves *without* human inspection, so it is logged
loudly (`RESOLVED ...` to stderr) rather than silently — contrast with the
opposite case (pending nonce already past the entry's nonce), which means a
transaction really may be in flight and must abort for manual inspection
instead.

### 2.7 Detecting success vs. revert

**A mined transaction is not a successful transaction.** After sending,
wait for the receipt (`w3.eth.wait_for_transaction_receipt`) and check
`receipt.status`: `1` means success, `0` means reverted. Never infer success
merely from a receipt existing.

**X Layer is an optimistic rollup — reorg handling:** wait for exactly 1
confirmation (the receipt) and no more. Nothing actually settles on a
reading until `finalize()` succeeds later — a separate step with its own
hour-long dispute window — so a shallow reorg in the seconds after
submission has a wide margin before it could matter. Waiting N additional
blocks per transaction, across ~1,448 submissions, would add real wall-clock
time (block time × N × every submission) for negligible benefit on a
testnet with ~0.86s blocks.

**On a revert, classify the reason into two buckets** (from
`contracts/src/GridOracle.sol`'s custom errors):

| Class | Errors | Action |
|---|---|---|
| **EXPECTED** | `ReadingAlreadyFinalized` | Not a failure — it's information. Mark that ledger entry `finalized`, log it, continue to the next reading. |
| **UNEXPECTED** | `UnauthorizedReporter`, `InvalidDayKey`, `InvalidMetricId`, `InvalidSourceHash`, `InvalidMarketDay` | Something is systemically wrong — wrong signing key, wrong chain/contract, or corrupted data. Every subsequent submission would fail identically. **Abort the run immediately.** Do not continue and log 1,400 more identical failures. |

The process **exits non-zero if any UNEXPECTED revert occurred** during the
run (whether it caused an abort, or — for the stuck-transaction case in
§2.8 — after retries were exhausted).

### 2.8 Nonce handling and stuck transactions

**Nonce:** track locally in Python. Seed once at startup from
`get_transaction_count(address, "pending")`, increment by 1 after each
successful send. On a "nonce too low" error, re-sync from chain and retry
once. This is a single-writer script against a key only one person holds at
a time — re-querying a fresh nonce before every one of ~1,448 sends was
rejected as unnecessary cost for a race condition that a coordination
message ("I'm about to run publish.py") already prevents. If David and the
reporter key are ever used concurrently by two processes, that's a
human-coordination problem, not something this script defends against.

**Stuck pending transaction** (sent, not mining — e.g. an underpriced spike):
wait up to a fixed timeout (60–120s) for a receipt. If absent, resend the
same nonce with a bumped gas price (a standard "replacement" transaction),
once, then once more. If still stuck after two bumps, log it as an
UNEXPECTED failure (§2.7) and abort — do not wait indefinitely; a stuck
transaction blocks every later nonce in the run.

**Fixed:** `send_reading`'s broadcast retry still only catches `ValueError`
internally (the exception type `send_raw_transaction` raises for a
"nonce too low" rejection) — that part is unchanged. But a non-`ValueError`
transport failure — an RPC connection drop, a socket timeout — anywhere
inside `send_reading` no longer propagates unwrapped past the submission
loop: `main()`'s per-reading `try` around `send_reading` now catches
`Exception` alongside `PublisherError`, both incrementing `failed`, setting
`abort_message`, and breaking out of the loop exactly as an UNEXPECTED
revert does. This routes it through the same end-of-run summary (§2.11) as
every other UNEXPECTED failure instead of skipping it.

### 2.9 Gas and RPC

**Gas policy:** auto-estimate per transaction (`estimate_gas`) plus the
network's current `eth_gasPrice` — no manual override, no hardcoded gas
limit or price. Measured live: ~0.02 gwei, ~180–220k gas per
`submitReading` — effectively free on this testnet, and auto-estimation
avoids a hardcoded number going stale if network conditions change.

**Insufficient OKB mid-run:** a send failing (or reverting) for lack of
funds is treated as an UNEXPECTED failure — abort. Everything already
`confirmed` stays in the ledger. Top up from the X Layer faucet and rerun;
the skip logic (§2.4) means the rerun only resubmits what's actually
missing.

**RPC endpoint:** `https://testrpc.xlayer.tech/terigon` — the same endpoint
David's Foundry deployment tooling uses (`contracts/foundry.toml`,
`[rpc_endpoints] xlayer_testnet`). Read from a new env var,
`XLAYER_RPC_URL`, defaulting to that value — never hardcoded anywhere else
in the script, so it can be pointed elsewhere without a code change.

**Pacing:** waiting for each transaction's receipt already paces actual
submissions at block-time cadence (~0.86s measured). Add a small fixed
courtesy sleep (~0.5s) before non-transaction RPC calls — nonce checks,
`getReading` during `--reconcile`/`--verify` — since this is a shared public
testnet endpoint, not a dedicated one.

### 2.10 Untrusted input validation

Metric JSON files are untrusted input — a malformed or tampered file must
never reach `submitReading`. Before any network call, for every file:

1. **Schema/plausibility checks** — reuse `scripts/validate_metrics.py`'s
   existing logic (required keys present, `dayKey` is a real calendar date,
   `marketDayStartUtc < marketDayEndUtc` and lands on Central midnight for
   `dayKey`, `sourceHash` is 64 lowercase hex chars, filename matches
   `metricId`/`marketDay`).
2. **Oracle-specific checks**, in addition:
   - `metricId` string is exactly one of the four frozen names in
     `shared/oracle-interface.md` — anything else (typo, an unexpected new
     metric, a fuel-mix file that slipped through a filter) is rejected, not
     guessed at.
   - `sourceHash`, once decoded from its hex string, is exactly 32 bytes —
     matches the `bytes32` the contract expects.
   - `value` fits within `int256` bounds.

A file that fails any check is **skipped and logged with its specific
reason** — never submitted with a best-guess or default value. Skipping is
always skip-and-continue, regardless of how many files fail (no gas is at
risk before a transaction is sent, so being strict here is free). But every
skipped file must be named, with its reason, in the end-of-run summary
(§2.11), and **the process exits non-zero if any file was skipped** — a
silently skipped file is a missing reading, and a missing reading is a
market that can't resolve.

### 2.11 Audit trail

Three artifacts, each serving a different need:

1. **`data/publish-ledger.json`** (§2.4) — the machine-readable source of
   truth for skip logic and the David→pipeline-owner hand-off. Committed to
   git.
2. **`logs/publish-<timestamp>.log`** (new `logs/` directory, gitignored,
   local/human-facing) — one line per reading attempted: `metricId, dayKey,
   value, txHash, outcome`. For pointing at a specific transaction live
   during the demo, without scrolling back through a long terminal session.
3. **End-of-run summary**, printed to stdout and worth capturing for the
   README:
   ```
   Submitted:        N
   Already published (skipped): N
   Already finalized (skipped): N
   Invalid files (skipped):     N  [listed individually above, with reasons]
   Failed (UNEXPECTED):         N  [run aborted if > 0]
   Wall-clock time:             MM:SS
   Total gas spent:             X.XXXXXX OKB
   ```

---

## 3. Security

### 3.1 Key storage — pluggable, not hardcoded to one mechanism

David is the sole holder of the reporter key and offered two ways to supply
it to `publish.py`. The script must support **either**, auto-detecting which
is configured, and must never assume one:

- **Environment variable** — `REPORTER_PRIVATE_KEY`, read via `os.environ`,
  the same convention `GRIDSTATUS_API_KEY` already uses in this repo's
  `.env` (already gitignored). Simplest, consistent with existing tooling.
- **Encrypted keystore file** — matching the Foundry keystore pattern
  already used for the deployer key (`cast wallet import ... --interactive`,
  per `shared/deployment.md`). A keystore path is configured
  (e.g. `REPORTER_KEYSTORE_PATH`); the script prompts interactively for the
  password each run — never accepted as a CLI argument, never echoed to the
  terminal or logged.

Whichever source is configured (e.g. keystore path present → use it, else
fall back to the env var), only the **derived address** is ever surfaced —
in the `--check`/`--live` banner, in the ledger, in logs. The private key or
keystore password is never printed, logged, passed as a CLI argument (which
`ps` would expose to any other process on the machine), or included in any
error message or stack trace. A missing or malformed key source fails fast
with a clear message that describes the problem without echoing the bad
value itself.

`finalize.py` uses this exact same pluggable model, independently, for its
own (different) key — see §4.4.

### 3.2 Preflight checks — `--check` mode

Three checks, mandatory before any `--live` submission, and also runnable
standalone via `publish.py --check` (exits after checking, sends nothing):

1. **Chain ID is 1952**, not X Layer mainnet (196) or anything else —
   `eth_chainId`.
2. **The oracle address holds contract code** — `eth_getCode` returns
   non-empty bytecode. Catches a wrong/typo'd address before it silently
   sends a no-op transaction to an EOA.
3. **The derived signer address equals the contract's `reporter()`** —
   catches a wrong key immediately, as a clear preflight message, instead of
   as 1,448 identical `UnauthorizedReporter` reverts.

`--check` also reports current wallet OKB balance. This is what David runs
first, before any `--live` job, to confirm his key/keystore is correctly
wired — and it's free and read-only, so there's no reason not to run it
every time before a long job.

### 3.3 Dry-run default

Covered in §2.5 — restated here because it's a security property, not just
a UX one: the default (safe) action is to do nothing, and sending real
transactions requires an explicit, confirmed opt-in. For someone new to
web3 tooling, the accidental action should never be the dangerous one.

---

## 4. `finalize.py` (sketch)

A separate script, separate from `publish.py`, run by the pipeline owner
with their own wallet — never the reporter key (see §1).

### 4.1 Why separate from `publish.py`

`finalize()` is **permissionless** — `contracts/src/GridOracle.sol` has no
`onlyReporter` modifier on it, unlike `submitReading`. Submission and
finalization are two operations with fundamentally different risk profiles:
submission is safe to re-run (governed by the ledger's skip logic);
finalization is a one-way door per reading (`ReadingAlreadyFinalized`
reverts any later attempt to touch it again). Keeping them as separate
scripts means a bug in one can't block or corrupt the other, and it's what
makes the David/pipeline-owner key split in §1 possible at all — the
finalizer never needs reporter permission.

### 4.2 What it does

```
finalize.py [--live] [--verify]
```

Without `--live`, prints what it would finalize (same dry-run-by-default
principle as `publish.py`). With `--live`:

1. Read the (git-pulled) ledger, `data/publish-ledger.json`. Collect every
   `(metricId, dayKey)` entry with `status == "confirmed"` (submitted, not
   yet known to be finalized).
2. For each, **re-check eligibility against a fresh on-chain read** —
   `getReading()` to get `publishedAt`, compute `publishedAt + disputeWindow`
   (`disputeWindow()` read live from the contract, not hardcoded — confirmed
   3600 today, but a spec shouldn't bake in a value that's itself an
   immutable contract parameter subject to redeployment), compare against
   current time. **Never trust the ledger's cached `publishedAt`** for this
   decision — only use the ledger to know *which* readings to check at all.
   This means hand-off lag between David committing the ledger and the
   pipeline owner pulling it doesn't matter for correctness, only for
   timing.
3. For everything currently eligible, call `finalize(metricId, dayKey)`
   using the finalizer's own key (§4.4). Apply the same success/revert
   detection as `publish.py` §2.7 (check `receipt.status`, don't assume
   mined means succeeded).
4. Update the ledger: mark each successfully finalized entry `status:
   "finalized"`.
5. Report: how many finalized this run, how many still waiting (and for how
   long each), how many failed and why.

No unattended scheduling (cron, a sleep-loop) — explicitly rejected: nothing
should be running unattended before the hackathon deadline that could
silently stop working. This is a manual, on-demand tool.

### 4.3 `--verify` — no wallet required

`getReading()` and `isFinal()` are free view calls. `--verify` needs nothing
but `XLAYER_RPC_URL` — no key, no keystore, no wallet, runnable from any
machine (a laptop in Singapore with nothing configured on it at all).

It reads the six demo `dayKey`s from `shared/demo-markets.md` (one per
demo market: `ERCOT_HBNORTH_DA_AVG` at `20260908`/`20260924`/`20261005`,
`ERCOT_WEST_NORTH_DA_BASIS` at `20260812`/`20260924`/`20261005`) and, for
each, reports:

```
ERCOT_HBNORTH_DA_AVG      dayKey 20260908   PUBLISHED, FINALIZED
ERCOT_HBNORTH_DA_AVG      dayKey 20260924   PUBLISHED, not finalized (18m remaining)
ERCOT_WEST_NORTH_DA_BASIS dayKey 20261005   NOT PUBLISHED
```

This is the pre-demo checklist as a command, not something recalled from
memory under time pressure.

### 4.4 Key source

Same pluggable model as §3.1 (env var or encrypted keystore, auto-detected,
never assumed, never logged/echoed) — but a **different** variable name so
the two scripts' configs can never be confused with each other, e.g.
`FINALIZER_PRIVATE_KEY` / `FINALIZER_KEYSTORE_PATH`. This wallet has no
special contract permission; it only needs testnet OKB for gas, from the
X Layer faucet.

---

## 5. Operator section (for David)

This section is written to be read on its own, without the rest of this
document, by someone who didn't sit through the interview that produced it.

**0. Before any `--live` run — including a rerun — `git pull` first,
always.** Starting from a stale local ledger means `publish.py` doesn't know
about readings a previous run already published, and will resubmit them —
silently restarting their dispute windows. This is the specific failure
this entire design exists to prevent, so it's step zero, not a footnote.

**1. Run `publish.py --check` first.** It verifies your key (or keystore)
derives the correct reporter address, that you're pointed at chain 1952 and
the right contract, and shows your wallet's OKB balance. It sends nothing
and costs nothing — there's no reason to skip it before a job that will run
for the better part of an hour.

**2. Run `publish.py --live`.** You'll see a confirmation banner showing the
chain ID, contract address, your signer address, your balance, how many
readings are queued, and an estimated time and cost. Type `yes` to actually
start. For the full backfill (all four metrics, the full year — ~1,448
readings), expect **~50–95 minutes** and on the order of **0.006 OKB
total** — effectively free.

**3. A clean run's summary looks like this** — zero in the last two lines:

```
Submitted:        1448
Already published (skipped): 0
Already finalized (skipped): 0
Invalid files (skipped):     0
Failed (UNEXPECTED):         0
```

Nonzero `Invalid files` or `Failed` means something needs attention before
you consider the run done — both are listed individually above the summary
with a reason.

**4. If the run aborts with an UNEXPECTED failure** (you'll see it named as
such, e.g. `UnauthorizedReporter` or `InvalidDayKey`): **stop, don't
immediately rerun.** This class of failure means something is systematically
wrong — wrong key, wrong chain, or corrupted input data — not a transient
network blip, and every later reading would fail the same way. Read the
specific error, fix whatever it points to, then rerun. It's safe to rerun
after fixing the cause: the ledger-based skip logic means it will only
attempt what's actually still missing, not start over.

**5. After a successful `--live` run, commit and push the ledger file**
(`data/publish-ledger.json`). That commit is how the pipeline owner's
`finalize.py` finds out what needs finalizing — without it, nothing on your
end reaches them.

---

## 6. Operational sequence and timeline

The full path from "metric files exist" to "a demo market can resolve,"
naming who does each step:

1. **David**: `publish.py --check`, then `publish.py --live` (his reporter
   key/keystore). Submits readings. Commits and pushes the ledger.
2. **Wait out `disputeWindow`** — confirmed live on-chain: **3600 seconds,
   1 hour.**
3. **Pipeline owner**: `git pull`, then `finalize.py --live` (their own
   wallet, needs testnet OKB for gas — unrelated to the reporter key).
   Finalizes everything currently eligible.
4. **Pipeline owner**: `finalize.py --verify` (no wallet needed). Confirms
   every demo market's `dayKey`, from `shared/demo-markets.md`, is both
   published and finalized before relying on it live.

Written down once so this cross-machine, cross-person sequence isn't
reconstructed under pressure before the Singapore finale.

**This is also a timeline, not just an order, and the two are not the same
constraint:**

- **Steps 1–3 must complete no later than the evening before the demo.**
  With `disputeWindow` at 3600 seconds, a problem discovered the morning of
  — a reading that failed to publish, or one still waiting out its window —
  cannot be fixed in time before going on stage. The hour of slack the
  contract gives you is real but small; the schedule has to give itself a
  much larger margin than that on top of it.
- **Step 4 (`--verify`) runs twice, not once:** the night before, as the
  real check that catches a problem while there's still time to act on it,
  and again the morning of, as confirmation that nothing regressed
  overnight. Both runs are identical — `--verify` needs no key or wallet, so
  either can run from any machine, including one that never touched steps
  1–3 at all.
- **David holds the reporter key, and step 1 depends on him specifically.**
  If he is not physically in Singapore, step 1 has to be scheduled around
  *his* timezone, not the demo's — that scheduling is part of this plan, to
  be settled in advance, not something worked out reactively on the day
  step 1 turns out to be late.

---

## 7. Config summary

New environment variables/config, to be documented in `.env.example`
alongside the existing `GRIDSTATUS_API_KEY`/deployment variables:

| Variable | Used by | Holder | Notes |
|---|---|---|---|
| `REPORTER_PRIVATE_KEY` | `publish.py` | David only | Alternative to keystore; never on the pipeline owner's machine |
| `REPORTER_KEYSTORE_PATH` | `publish.py` | David only | Alternative to env var; password prompted interactively |
| `FINALIZER_PRIVATE_KEY` | `finalize.py` | Pipeline owner | Separate wallet, no contract permission needed |
| `FINALIZER_KEYSTORE_PATH` | `finalize.py` | Pipeline owner | Alternative to env var |
| `XLAYER_RPC_URL` | Both | — | Default `https://testrpc.xlayer.tech/terigon` |

Path/gitignore decisions:

| Path | Tracked? | Why |
|---|---|---|
| `data/publish-ledger.json` | **Committed** | David→pipeline-owner hand-off artifact; contains only public testnet data |
| `logs/*.log` | Gitignored | Local, human-facing run logs; not needed cross-machine |

---

## 8. Non-goals (explicitly out of scope for this spec)

- Publishing `ERCOT_FUELMIX_<FUEL>` — no frozen `metricId` hash exists;
  would require extending `shared/oracle-interface.md` first.
- Any unattended scheduling (cron, always-on process) for either script.
- Redeploying `GridOracle` with a different `reporter` or `disputeWindow` —
  both are immutable constructor parameters; changing either means a new
  deployment, a `shared/addresses.json` update, and is out of scope here.
- Concurrent use of the same reporter/finalizer key from two processes at
  once — treated as a coordination problem solved by communicating, not by
  code (see §2.8).
