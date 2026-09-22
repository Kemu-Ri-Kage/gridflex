# GRIDFLEX `finalize.py` spec

**Status: spec only, no implementation yet.** This supersedes the sketch in
`shared/publish-spec.md` §4 with the full detail needed to implement
`finalize.py` without further design decisions. Like that document, this one
contains no Python code — pseudocode and prose only. It was produced by
interviewing the pipeline owner in detail, using §4's sketch as the starting
point; every decision below states its rationale so it doesn't need to be
re-derived later.

This assumes `shared/oracle-interface.md` (the frozen interface) and
`contracts/src/GridOracle.sol` (the deployed contract) as ground truth. The
relevant slice of the deployed contract, read directly for this spec:

```solidity
error ReadingNotFound(bytes32 metricId, uint32 dayKey);
error ReadingAlreadyFinalized(bytes32 metricId, uint32 dayKey);
error DisputeWindowOpen(uint256 finalizableAt);

function finalize(bytes32 metricId, uint32 dayKey) external {
    Reading storage reading = _readings[metricId][dayKey];
    if (reading.publishedAt == 0) revert ReadingNotFound(metricId, dayKey);
    if (reading.finalized) revert ReadingAlreadyFinalized(metricId, dayKey);

    uint256 finalizableAt = uint256(reading.publishedAt) + disputeWindow;
    if (block.timestamp < finalizableAt) revert DisputeWindowOpen(finalizableAt);

    reading.finalized = true;
    emit ReadingFinalized(metricId, dayKey);
}
```

No `onlyReporter` modifier — `finalize` is callable by anyone, which is the
organizing fact for this whole document, same as it is for `publish.py`
(`shared/publish-spec.md` §1).

---

## 0. Relationship to `publish.py` — what's reused, what's different

`finalize.py` shares four things with `publish.py` outright, and should
import/reuse the same code where the two scripts live in the same repo,
not reimplement them:

- **The ledger file and schema** — `data/publish-ledger.json`, same
  `(metricId, dayKey)` keys, same fields, same atomic-write helper. This
  document adds no new ledger fields.
- **The pluggable key-source model** — env var or encrypted keystore,
  auto-detected, address-only in output, never logged (`publish-spec.md`
  §3.1) — under new variable names, `FINALIZER_PRIVATE_KEY` /
  `FINALIZER_KEYSTORE_PATH`, already named in `publish-spec.md` §4.4 and §7.
- **The revert-classification framework** — decode the custom-error
  selector from a revert, look it up against the ABI (`build_error_selectors`
  in `publish.py`), route EXPECTED vs. everything-else through different
  handling. The *bucketing itself* is different here — see §5 below — but
  the mechanism (selector table built from the ABI, not hardcoded) is
  identical.
- **Nonce handling, RPC pacing, gas policy, and audit-trail conventions** —
  local nonce counter seeded from `get_transaction_count(pending)`,
  resync-once on "nonce too low", stuck-transaction handling (60–120s
  timeout, up to two gas-price bumps then abort), auto-estimated gas,
  ~0.5s courtesy sleep before non-transaction RPC calls, a `logs/` line per
  attempt, and a summary printed on every exit path. All of `publish-spec.md`
  §2.8–§2.9 applies to `finalize.py` unchanged — a `finalize()` call is a
  transaction like any other from the node's point of view. The
  single-writer assumption (§2.8: no defense against two processes racing
  the *same* key) holds identically; a stranger calling `finalize()`
  permissionlessly from elsewhere cannot collide with the finalizer wallet's
  own nonce space, since nonces are per-sender.

What's genuinely different, each covered in its own section below:

| Difference | Section |
|---|---|
| Discovery: what set of readings a run even considers | §1 |
| Eligibility: fresh on-chain dispute-window check, no waiting | §2 |
| A safety check that has no analogue in `publish.py`, because finalizing a wrong value is irreversible | §3 |
| Confirmation banner scaling from 6 readings to ~1,448 | §4.2 |
| Revert bucketing: per-reading isolation instead of abort-on-first | §5 |
| `--verify`: a read-only mode `publish.py` has no equivalent of | §6 |

---

## 1. Discovery — what a run considers

**Decision: discovery is driven by local metric files, exactly like
`publish.py`'s `collect_readings`, not by the ledger.** The ledger is a
handoff artifact — the § in `publish-spec.md` that establishes it (§2.4)
also establishes it can drift from truth. If discovery started from the
ledger's `"confirmed"` entries, a reading the ledger never learned about
(David's process crashed after sending but before committing the ledger; a
manual `submitReading` call outside `publish.py`; a stale `git pull` on the
finalizer's machine) would be invisible to `finalize.py` even though it's
sitting on-chain, eligible, waiting.

Instead:

1. Scan `data/metrics/*.json` for the metrics in scope (see below),
   optionally narrowed by `--metric`/`--start`/`--end`/`--days`, exactly as
   `publish.py`'s `collect_readings` does — reuse that function.
2. For each file, compute `(metricId, dayKey)` and read the reading fresh
   from chain via `getReading()`. **The ledger is not consulted to decide
   whether to check a reading — only local files are.** The ledger is
   updated *after* each check (§7), not read *before* one.
3. A reading whose `getReading()` returns `publishedAt == 0` (i.e. nothing
   on-chain at that key) is **not published** — skip it, log it, don't call
   `finalize()`. This is expected and common (most of the year's readings
   won't be published until David runs the backfill) and is not a failure.

Because `data/metrics/*.json` is git-committed (unlike `data/raw/`), this
approach costs nothing to keep in sync — whoever runs `finalize.py` already
has the same universe of candidate files David published from, independent
of whether the ledger hand-off happened cleanly.

**Scope: all four in-scope metrics by default, not just the two contract
metrics.** This mirrors the precedent `publish-spec.md` §2.2 already sets for
`publish.py` and extends it one step further: that section publishes all
four metrics (not just the two that settle contracts) on the reasoning that
"if the site's feed display is meant to read from the chain... this needs to
actually be there." A feed reading that's published but never finalized is
the same gap for `isFinal()`-based display logic that an unpublished one
would be — there's no reason to leave `ERCOT_LOAD_WEIGHTED_DA_INDEX` and
`ERCOT_HBWEST_NEG_INTERVALS` readings permanently un-finalized while the two
contract metrics get finalized. `--metric NAME` (repeatable) narrows this the
same way it does in `publish.py`.

---

## 2. Eligibility — fresh on-chain check, report and move on

For every reading found published (§1) and not yet finalized:

1. Read `disputeWindow()` from the contract **once per run** (it's an
   immutable constructor parameter — one call, not one per reading, unlike
   `getReading` which is genuinely per-reading state).
2. Compute `finalizableAt = publishedAt + disputeWindow` from the fresh
   `getReading()` result — **never from anything cached in the ledger**,
   per `publish-spec.md` §4.2 point 2, restated here because it's the core
   correctness property of this whole step: hand-off lag between David
   committing the ledger and the pipeline owner pulling it must not be able
   to produce a wrong eligibility decision.
3. If `now < finalizableAt`: **not yet eligible.** Print the reading's key
   and remaining time (e.g. `ERCOT_HBNORTH_DA_AVG 20260924: 18m remaining`),
   do not call `finalize()`, move to the next reading. No blocking, no
   polling loop — `publish-spec.md` §4.2 already rejects "any unattended
   scheduling (cron, a sleep-loop)" as a non-goal, and waiting inside a
   single run for up to an hour is the same thing with extra steps.
4. If `now >= finalizableAt`: eligible — proceed to §3's safety check, then
   §5's `finalize()` call.

---

## 3. Value-match safety check (new — no analogue in `publish.py`)

**This is the one check that must never be skipped, stated up front because
it follows directly from `finalize()` being a one-way door.** The pipeline
methodology already names the equivalent risk on the publish side — "a half-day value
settling a contract is a real-money bug" — and finalizing locks a value in
*permanently*, which is a strictly higher-stakes version of the same
category of mistake.

Before calling `finalize()` on an eligible reading, compare the **on-chain**
`value` (from the same `getReading()` call used for eligibility) against the
**local metric file's** `value` (already loaded during discovery, §1):

- **Values match:** proceed to `finalize()`.
- **Values differ:** **do not call `finalize()`.** This is not a revert to
  classify (§5) — it's a local pre-check failure, caught before any RPC
  send. Log it loudly and specifically: something has diverged between what
  the local pipeline currently computes for this day and what's actually
  on-chain (a correction was computed locally but never re-submitted via
  `publish.py`; the metric file was regenerated after publication; stale
  local state). Report it as that reading FAILED (§5's per-reading
  isolation — this doesn't abort the run) and move to the next reading.
  **Investigate before ever finalizing this specific reading** — once
  finalized, the on-chain value can never be corrected.

**`sourceHash`-only divergence, with `value` unchanged, is explicitly not a
failure here** — reuse the exact distinction `publish-spec.md` §2.4's
"Named failure mode: `sourceHash` drift without a value change" already
established: `fetch_ercot.py`'s monthly cache chunking can legitimately
produce a different `sourceHash` for an unchanged `value` across two
pipeline runs. Only a `value` mismatch is a real problem; hashing that same
paranoia onto `sourceHash` would false-positive on ordinary, already-
understood pipeline behaviour. A `sourceHash`-only mismatch may be logged as
a note but does not block finalization.

---

## 4. CLI surface and confirmation

```
finalize.py [--metric NAME] [--start YYYYMMDD | --days N] [--end YYYYMMDD]
            [--limit N] [--live] [--check]
finalize.py --verify [--metric NAME --day-key YYYYMMDD]
```

- `--metric`, `--start`/`--end`/`--days`, `--limit` — same semantics as
  `publish.py` (§1's discovery filters them the same way `collect_readings`
  does). Default metric scope: all four in-scope metrics (§1).
- `--check` — preflight only, sends nothing: chain ID is 1952, the oracle
  address holds contract code, the finalizer key loads and derives an
  address, current wallet OKB balance. **No reporter-address check** — unlike
  `publish.py` §3.2's third check, there is nothing to compare against,
  since `finalize()` has no access control to get wrong.
- `--live` — send transactions. Without it, always a dry run (§4.1).
- `--verify` — a separate, wallet-free read-only mode; see §6. Mutually
  exclusive with `--live`/`--check`/the date-range flags.

### 4.1 Dry run by default

Same principle as `publish.py` §2.5: a bare `finalize.py` (no `--live`)
never sends a transaction — it prints what it would finalize (eligible
now), what it would report as not-yet-eligible (with remaining time), what
it would skip as already-finalized, and what it would flag as a
value-mismatch failure (§3), then exits.

### 4.2 `--live` confirmation banner — scaled, not just counted

`finalize()` is a one-way door per reading, which argues for showing the
operator exactly what's about to become permanent, not just a count — but
the batch size varies enormously in practice. The demo-market runs the
night before Singapore are ~6 readings; the *first* real `--live` run,
roughly an hour after David's initial backfill (`publish-spec.md` §2.2,
~1,448 readings across the full year), will likely have on the order of
~1,448 readings eligible at once, since `disputeWindow` is the same 3600s
for all of them.

**Rule: list individually up to a cap, summarize above it.**

- If the number of readings to finalize this run is **≤ 25**: list each one
  individually — `metricId`, `dayKey`, `value` — in the confirmation banner,
  the same way `publish.py`'s live banner shows a single count. This covers
  every normal demo-prep run with full visibility.
- Above 25: print per-metric counts (e.g.
  `ERCOT_HBNORTH_DA_AVG: 724   ERCOT_WEST_NORTH_DA_BASIS: 724`) plus a short
  sample (first 10 individually listed), instead of a multi-thousand-line
  banner that defeats the purpose of listing readings in the first place.

Either way, the banner still shows chain ID, oracle contract address,
finalizer signer address (derived from the configured key, never the key
itself), wallet balance, estimated duration/cost, and requires the same
typed `"yes"` `publish.py` does — no `--force`/`--yes` flag to skip it.

---

## 5. Revert classification — per-reading isolation, not abort-on-first

`publish.py` aborts the whole run on the first UNEXPECTED revert
(`publish-spec.md` §2.7) because most of its non-expected reverts really are
systemic: a wrong reporter key or wrong chain makes every subsequent
`submitReading` call fail identically, so continuing would just log 1,400
more identical failures.

**That reasoning doesn't transfer to `finalize.py`, because it has no
equivalent systemic failure mode** — there's no reporter-key check to get
wrong, since `finalize()` is permissionless. Its three custom errors are
each per-reading in character, not systemic:

| Error | Classification | Handling |
|---|---|---|
| `ReadingAlreadyFinalized` | **EXPECTED** | Someone else — anyone, since `finalize()` is permissionless — finalized this specific reading between our fresh eligibility check (§2) and our transaction landing. Not a failure, just information: update the ledger entry to `"finalized"` (reading its true state fresh from chain), log it, continue. |
| `ReadingNotFound` | **Per-reading FAILED** | Should not happen if §1's discovery is working correctly (we only attempt readings we just confirmed exist via `getReading`), so this points at a bug or a reorg-level race. Log it specifically, count it as that reading failed, continue to the next reading. |
| `DisputeWindowOpen` | **Per-reading FAILED** | Should also not happen given §2's fresh eligibility check immediately precedes the call — if it fires anyway (clock skew, a long pause between check and send), it's an anomaly on one reading, not evidence the whole run is broken. Log it, count it as failed, continue. |
| Unrecognized selector / non-revert transport error | **Per-reading FAILED** | Same handling — log with whatever detail is available, count as failed, continue. Per `publish-spec.md` §2.8's "known gap, unfixed" note, make sure this path also catches non-`ValueError` transport failures (a dropped RPC connection, a timeout), not just contract reverts — that gap in `publish.py` should not be reproduced here. |

**True aborts are reserved for preflight failures, checked once before the
per-reading loop starts** — wrong chain ID, no contract code at the oracle
address (the two checks from `publish.py` §3.2 that still apply here; the
third, reporter-address matching, doesn't). A bad reading anywhere in the
batch never blocks finalizing the rest of the batch — which matters more
here than in `publish.py`, since a `finalize.py --live` run is typically a
small, deliberate, time-boxed action close to the demo (`publish-spec.md`
§6: "steps 1–3 must complete no later than the evening before the demo"),
where one flaky reading blocking five good ones the night before Singapore
would be strictly worse than isolating it.

---

## 6. `--verify` — read-only, no wallet

Exactly as `publish-spec.md` §4.3 describes: `getReading()` and `isFinal()`
are free view calls, so `--verify` needs only `XLAYER_RPC_URL` — no key, no
keystore, runnable from a laptop in Singapore with nothing else configured.

### 6.1 Default: the demo markets

With no further flags, `--verify` parses `shared/demo-markets.md`'s
**`## Summary table`** section specifically — the pipe-delimited table near
the bottom of that file — not the surrounding prose. The table is the one
part of that document that's already structured for exactly this purpose;
the rest is written for a human audience (footnotes, seasonal analysis,
revision notes) and would make a fragile parse target.

For each row, report one of:

```
ERCOT_HBNORTH_DA_AVG      dayKey 20260908   PUBLISHED, FINALIZED
ERCOT_HBNORTH_DA_AVG      dayKey 20260924   PUBLISHED, not finalized (18m remaining)
ERCOT_WEST_NORTH_DA_BASIS dayKey 20261005   NOT PUBLISHED
```

`NOT PUBLISHED` (a dayKey with no on-chain reading at all) is a normal,
expected finding to report — not a parse error. It means exactly what it
says: nothing has reached the chain yet for that key.

**If the table itself can't be parsed** — its column layout no longer
matches what the parser expects, because `shared/demo-markets.md` changed
shape — **fail loudly and exit non-zero**, naming the problem (e.g. "expected
N columns in the Summary table, found M — has the table's format changed?
See shared/finalize-spec.md §6.1"), rather than silently returning fewer
rows or guessing. This document's table already changed once (two `dayKey`s
moved from `20261006` to `20261005`, per that file's own note) — the parser
should be brittle on purpose here, since a silently-wrong pre-demo checklist
is worse than a loud one that needs a five-minute fix.

### 6.2 Ad hoc: `--metric` / `--day-key`

`--verify --metric ERCOT_HBNORTH_DA_AVG --day-key 20260910` checks exactly
that one pair, using the same `getReading()`/`isFinal()`/eligibility logic
as the default six, instead of parsing `demo-markets.md` at all. This is a
free read-only call, so there's no reason to withhold it — useful for
debugging any reading during development, not only the six pinned for the
demo. `--metric` here takes exactly one value (not repeatable, since it's
paired 1:1 with a single `--day-key`) — a different mode from `--metric`'s
repeatable use for `--live`/dry-run filtering in §4.

---

## 7. Audit trail and exit codes

Same three artifacts as `publish.py` (`publish-spec.md` §2.11), reused
directly:

1. **`data/publish-ledger.json`** — for every reading checked this run
   (regardless of prior ledger state — §1 deliberately doesn't require a
   prior entry to exist), write/update its entry from the fresh
   `getReading()` result, same pattern as `publish.py`'s
   `ledger_entry_from_chain`: `status: "finalized"` for anything finalized
   this run or found already finalized, left alone otherwise. This is how a
   ledger row that never existed (§1's motivating case) gets backfilled
   going forward, not just read. **Refreshing an existing row must preserve
   its original `nonce`, `txHash`, `blockNumber`, and `submittedAt`.** Those
   audit fields cannot be reconstructed from `getReading()` and are used by
   the feed and hand-off workflow; only a genuinely missing row is marked
   `recoveredFromChain` with unavailable transaction fields set to `null`.
2. **`logs/finalize-<timestamp>.log`** — one line per reading attempted:
   `metricId, dayKey, txHash, outcome`.
3. **End-of-run summary**, printed on every exit path (including an abort):

   ```
   GRIDFLEX finalize summary
     Finalized:                       N
     Not yet eligible (skipped):      N  [listed individually above, with remaining time]
     Already finalized (skipped):     N
     Not published (skipped):         N
     Failed (skipped, this reading):  N  [listed individually above, with reasons]
     Wall-clock time:                 MM:SS
     Total gas spent:                 X.XXXXXX OKB
     Ledger updated:                  data/publish-ledger.json
   ```

**Exit codes:**

- `--check`: `0` on a clean preflight, non-zero if any check fails.
- `--live`: `0` if the run completed with zero FAILED readings.
  Non-zero if any reading FAILED (§5's per-reading revert bucket, or §3's
  value-mismatch safety stop) — mirroring `publish.py`'s "exits non-zero if
  any UNEXPECTED revert occurred." **`Not yet eligible` alone does not flip
  the exit code** — it's an expected, informational outcome (§2), not a
  failure. A true preflight abort (wrong chain, no contract code) is also
  non-zero, same as `publish.py`.
- `--verify`: `0` **only if every checked reading is `PUBLISHED, FINALIZED`**;
  non-zero if anything is `NOT PUBLISHED`, published-but-not-finalized, or
  if `shared/demo-markets.md`'s table failed to parse (§6.1). This is
  deliberate: `publish-spec.md` §4.3 frames `--verify` as "the pre-demo
  checklist as a command," and a checklist that always exits `0` regardless
  of findings can't be scripted or trusted as a gate — the operator would
  have to read and correctly interpret the printed text every time instead
  of being able to check `$?`.

---

## 8. Security

### 8.1 Key storage

Identical model to `publish-spec.md` §3.1, under the `FINALIZER_*` names
already reserved in §4.4/§7 of that document: `FINALIZER_KEYSTORE_PATH`
(interactive password prompt, never a CLI arg, never echoed) or
`FINALIZER_PRIVATE_KEY` (env var), auto-detected, keystore preferred when
both are present. Only the derived signer address is ever surfaced, in
`--check`/`--live` output and the ledger — never the key or password. This
wallet carries no special contract permission (`finalize()` has none to
grant) — it exists purely to pay gas, funded from the X Layer faucet like
any other testnet wallet.

### 8.2 Dry-run default

Restated as a security property, not just UX, same as `publish-spec.md`
§3.3: the default action is to do nothing, and finalizing anything — an
irreversible action — requires an explicit, confirmed `--live` opt-in with
no bypass flag.

---

## 9. Non-goals (explicitly out of scope)

- Any unattended scheduling (cron, always-on process, or an in-process
  sleep-loop waiting out a dispute window) — `publish-spec.md` §4.2's
  rejection applies unchanged; §2 above reports remaining time instead of
  waiting for exactly this reason.
- Automatically resubmitting or correcting a reading whose on-chain value
  doesn't match the local file (§3) — that's `publish.py`'s job, run by
  David with the reporter key, which `finalize.py` never holds. `finalize.py`
  only refuses to finalize the mismatch; it does not attempt to fix it.
- Redeploying `GridOracle` with a different `disputeWindow` — immutable,
  out of scope here exactly as `publish-spec.md` §8 already states for
  `reporter`.
