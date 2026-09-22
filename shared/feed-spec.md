# GRIDFLEX feed page spec

**Status: spec only as of this writing; implementation follows this
document.**

Read-only page. No wallet, no transactions, no MetaMask connection required
— everything on this page is a free view call or a committed file, which is
also the point: this is the page that proves "everything visible is
verifiably onchain," and it must never depend on a signer to prove it.

Owned by the pipeline owner, same as the rest of this repo. The
`web/` markets/positions pages and wallet flow (`web3-provider.tsx`,
`trade-panel.tsx`, `wallet-button.tsx`) and everything under `contracts/`
are untouched by this spec — this page reuses `lib/contracts.ts`'s existing
`gridOracleAbi`, `xLayerTestnet`, and address wiring, but adds no wallet
requirement of its own.

Context this spec is written against: the OKX Dev Day submission requires a
2-4 minute demo video and a live product link. This page is the one judges
can load without a wallet, so it is the default "here's the product" screen
— it must render something real and correct within the length of a demo
video regardless of RPC conditions on a shared public testnet endpoint.

---

## 1. Data model: hybrid, not chain-only

Two committed, git-tracked sources are the ground truth this page's
rendered data traces back to — see §9 for exactly how they reach the
deployed page:

- **`data/metrics/*.json`** — one file per (metricId, marketDay), the
  pipeline's own computed values: `value`, `sourceHash`, `sourceFiles`,
  `marketDay`, `marketDayStartUtc`/`marketDayEndUtc`. Already git-committed;
  already exactly what was (or will be) submitted on-chain.
- **`data/publish-ledger.json`** — the reporter-to-pipeline-owner hand-off ledger, keyed
  `metricId:dayKey`, carrying `txHash`, `status`, and (once `finalize.py`
  has run) `status: "finalized"`. Also already git-committed
  (`publish-spec.md` §2.11).

**The page itself does not read these ~1,448 raw files directly** (2,168
files exist under `data/metrics/`, but 720 of those are
`ERCOT_FUELMIX_<FUEL>` — structurally out of scope, no `metricId` hash
exists for them at all, per `publish-spec.md` §2.2; ~1,448 is the total
across the four in-scope metrics this page actually draws from, confirmed
directly by running `build_feed_data.py` §9 against the real dataset).
A small
pipeline-owned aggregation step (§9) trims and combines them into a
handful of small files under `web/public/data/`, which is what the page
actually fetches. The policy this section commits to is the *source of
truth* (committed pipeline files, not a live-only read) — §9 covers the
concrete hand-off mechanism.

The page's charts and table values render from this committed data, not
from a live RPC call — this is what makes "the RPC is slow during the
demo" a non-event rather than an outage. A live call only ever powers one
thing: a small per-row verification-state indicator (§4).

**Why not chain-only.** `web3-provider.tsx` already shows the tradeoff
directly: even with a graceful fallback, a wallet-connected page's numbers
are hostage to one public testnet RPC endpoint at the moment someone loads
it. This page has no such excuse to take that risk, because everything it
needs to show is already sitting in git, computed once, hashed, and
auditable — the live check is additive proof, not the only source of truth.

**Why not committed-JSON-only either.** Skipping the live call entirely
would make "everything visible is provably on-chain" an unverified claim on
the one page whose entire purpose is proving it. The hybrid model keeps the
live check, just demotes it from "renders the page" to "confirms the page."

## 2. Which readings are listed — discovery, not a fixed list

Mirrors `finalize.py`'s own discovery pattern (`finalize-spec.md` §1),
deliberately, for the same reason: **a reading is only listed once it's
been confirmed to actually exist on-chain**, checked fresh, not assumed
from a local file or a ledger's cached status.

1. Every metric-day the aggregation step (§9) knows about is a candidate;
   the ledger's own `txHash` presence marks which candidates were actually
   submitted at all — a candidate with no `txHash` was never even sent, so
   there is nothing on-chain to check for it and it is not attempted.
2. For each candidate that was submitted, call `getReading()`. Listed
   **only if the call succeeds** — a transport failure removes that
   candidate from this render (§6), it does not render as "not published."
3. Never list a reading solely because a local file or ledger entry exists
   for it, and never skip the live call and assume the committed data is
   still accurate. A reading that's computed locally but never submitted
   is not "verified" by any definition this page uses, and must not
   appear as if it were.

**Today, this means exactly 3 rows** — `dayKey 20250910` for
`ERCOT_HBNORTH_DA_AVG`, `ERCOT_HBWEST_NEG_INTERVALS`, and
`ERCOT_LOAD_WEIGHTED_DA_INDEX` (a smoke-test publish, not the real
backfill, and not one of the six demo-market dayKeys).
**`ERCOT_WEST_NORTH_DA_BASIS` — this spec's own hero chart's metric — has
zero on-chain readings as of this writing.** This is stated here so it is
never mistaken for a bug during implementation or the demo: the chart
(§5) still renders its full local history regardless, because chart data
comes from committed files, not from the discovery loop above; only the
verified-readings table (§4) is limited to what discovery actually finds.

**The honest counter.** Above the table, show real coverage:
`"{submitted_count} of {total_local_candidates} metric-days published so
far"` — `submitted_count` from the ledger's own record of what was ever
actually sent (currently 3), `total_local_candidates` from the full local
dataset across the four in-scope metrics (currently ~1,448). This number
is allowed to be small and
unimpressive — that's the truth of a pre-backfill state, and this page's
whole premise collapses if it ever shows something it can't back up live.

## 3. What "must never look broken" means, precisely

- **Zero on-chain readings for a given metric is not an error state.** The
  page must render correctly with the counter reading "0 of N" for a
  metric — no error banner, no red state, just an honest, calm "not
  published yet."
- **A slow/failed RPC call during discovery or the per-row verify check
  (§4) degrades to the last-known-good state, never to a spinner or a raw
  error.** See §6. This applies only to a call that fails to *complete* —
  a call that completes and disagrees with the committed file is a
  MISMATCH (§4), which is the one state that's supposed to look alarming,
  on purpose.
- **The page never needs `--live`-mode data or a wallet to render fully.**
  Every one of the above is true with the RPC entirely unreachable, because
  the table and charts are sourced from committed files first.

## 4. "Verified" — the visual language

Extends the "Verified ERCOT readings" card already stubbed in
`web/app/page.tsx`, per row:

- The reading's `metricId` (human label, e.g. "West–North basis") + its
  value (formatted `$X.XX/MWh`, dividing the raw `int256` by 100 per
  `oracle-interface.md`'s stated scaling — never display the raw integer).
- The truncated `sourceHash` (`sha256 75999d01…`), full hash on
  hover/click, sourced from the committed metric file.
- A link to the transaction on the OKX X Layer explorer
  (`https://www.okx.com/web3/explorer/xlayer-test`, already the base URL
  in `lib/contracts.ts`'s `xLayerTestnet.blockExplorers.default`), using
  the `txHash` from `data/publish-ledger.json` for that
  `metricId:dayKey` — **not** from the on-chain struct, which has no
  `txHash` field at all (checked directly against `oracle-interface.md`).

**Exactly one verification-state indicator per row — not two.** A static
"found on-chain" checkmark and a separate live-verified line underneath
read as two different claims when a viewer only takes in one, and the
first tick is the one that gets read as "verified" whether or not it's
the one doing the actual work. There is a single indicator per row, driven
entirely by the live per-row check (a fresh `getReading()` call, its
`value` and `sourceHash` compared against the committed file's), always in
exactly one of four states:

| State | Meaning | Treatment |
|---|---|---|
| **VERIFIED** | The most recent live check succeeded and matched the committed file exactly. | Green check + "on-chain ✓ verified {N} ago" (e.g. "verified 12s ago"). |
| **UNVERIFIED** | No live check has succeeded yet this session (first paint before the first check resolves, or every attempt so far has failed to reach the chain). | Neutral, calm — a grey clock glyph + "not yet verified this session." Not alarming; this is the normal state for the first second or two after load. |
| **LAST VERIFIED {N} AGO** | An earlier check in this session succeeded; the most recent attempt failed to *reach* the chain (timeout, dropped connection, RPC error response) — a network blip, not a data problem. | Neutral/aged — a faded check + "last verified {N} ago." Degrades quietly; never looks broken. |
| **MISMATCH** | A live check **succeeded** (the RPC responded) but the returned `value` or `sourceHash` does not match the committed file. | **Loud and red** — a red warning glyph + "MISMATCH — on-chain data differs from the published file," visually distinct from every other state, not a variant of it. |

**MISMATCH is a result, not a failure, and must be handled as the
opposite of one.** The retry-with-backoff-then-degrade logic in §6 exists
for calls that *fail to complete* — a timeout or transport error. A call
that completes and returns disagreeing data is definitive: it is **never
retried away** and **never degrades to LAST VERIFIED**, because doing
either would silently launder the one finding that actually matters on
this page — that the published data and the chain disagree — into
something indistinguishable from an ordinary network hiccup. It renders
MISMATCH immediately and stays MISMATCH until a subsequent, independent
check (e.g. the next page load) resolves differently.

## 5. The hero chart: West–North basis over time

**What's plotted.** `ERCOT_WEST_NORTH_DA_BASIS`'s `value` (÷100 for
$/MWh, signed) against `marketDay` (the ISO date field — never `dayKey`
formatted as if it were a date; `dayKey` is an opaque identifier by design,
per `oracle-interface.md`'s "why `dayKey` is `uint32 YYYYMMDD`, not a
timestamp"), across the full local history in
`data/metrics/ERCOT_WEST_NORTH_DA_BASIS__*.json` (via the §9 aggregate) —
independent of §2's on-chain discovery, since the chart's job is to show
the shape of the metric, not to claim every plotted point is individually
chain-verified today.

**Why this metric, not HBNORTH.** A basis line visibly crossing zero reads,
in seconds, as "a spread, not a price" — the exact thing a derivatives
contract needs a viewer to intuit, and it foreshadows the real seasonal
story in `demo-markets.md` (positive on all 20 days of the 2025
17-Sep–6-Oct analog window, a fact worth being able to point at live on the
chart itself during the pitch).

**Treatment.** The zero line is visually emphasized (not just an axis
gridline) — crossing it is the story.

**Secondary chart, below the fold.** `ERCOT_HBNORTH_DA_AVG`'s day-ahead
price line, smaller, same committed-data sourcing, same `marketDay`
x-axis. Present because it's the other contract metric a real market
settles against; deliberately not given equal visual weight to the hero
chart.

**Cut from this version.** Fuel mix (`ERCOT_FUELMIX_<FUEL>`) — feed-only,
display-ratio, per `metrics.md`, and the metric least connected to
anything that actually settles a contract. Not part of this spec. If it's
wanted later, that's a new, explicit decision (same posture `metrics.md`
already takes toward the load-weighted index becoming a contract metric
post-hackathon — not something to build toward preemptively).

## 6. Resilience for a live demo

- **Committed-data rendering (table values, both charts) has no RPC
  dependency at all** — this is the primary defense, not a fallback. A
  totally unreachable RPC endpoint still produces a fully-rendered, correct
  page; only the live-verified indicators (§4) are affected.
- **Each row's live verify check**: short timeout (~3-5s), one retry with
  backoff **on timeout/transport failure only** — i.e. the call did not
  complete — then fall back silently to whatever the last successful
  check in this session found (LAST VERIFIED), or UNVERIFIED if there
  hasn't been one yet. Never an error banner for this specific case, never
  a stuck spinner — the row's committed value is already showing
  regardless of what this check does.
- **A call that completes and disagrees with the committed file is never
  routed through the retry/degrade path above.** MISMATCH (§4) is a
  distinct outcome from "the call failed" — it is diagnosed the moment
  the disagreeing response is received, rendered immediately, and is not
  retried, timed out, or aged into LAST VERIFIED. Conflating the two would
  hide the one failure mode this page exists to surface.
- **Discovery (§2)'s live `getReading()` calls** get the same treatment:
  if a call fails, that reading is treated as "not confirmed this check" —
  it drops out of (or never enters) the verified table for this render; it
  does not crash the whole page or blank out readings that were already
  confirmed earlier in the same session.
- This is a stricter posture than `web3-provider.tsx`'s existing pattern
  (which does surface a dismissable error string) precisely because this
  page has a committed-data fallback available and that page mostly
  doesn't — matching, not exceeding, is not the goal here; never looking
  broken during a demo is.

## 7. Layout — the one screen

Above the fold, in one view: the coverage counter, the West–North basis
hero chart, and the verified-readings table (§2-§4). This is the single
screen to point at and say "this is GRIDFLEX" — a judge sees a real chart
shaped like a tradeable spread, and a small table of readings each
individually provable back to a hash and a transaction, without scrolling
or connecting anything.

Below the fold: the secondary HBNORTH chart (§5). No wallet button or
connect prompt originates from this page itself — if the shared site header
carries one (it does, for the wallet-enabled pages), that's outside this spec's
concern.

## 8. Non-goals — explicitly out of scope for this spec

- Fuel mix, in any form (chart or table) — see §5.
- Any interaction that requires a wallet or signs anything — that's
  the wallet-enabled pages.
- A "verify it yourself, click to re-check live" affordance — considered
  and not chosen; the passive per-row indicator (§4) was judged to convey
  "verified" clearly enough without adding another live-RPC-dependent
  interaction to a page whose whole point is not depending on one.
- A server/API route as the data source — considered and not chosen, to
  avoid introducing a new backend code path this repo doesn't otherwise
  have, on a deployment (Cloudflare Workers via `wrangler`) not yet proven
  out for one.
- Deriving the tx-hash link from a live `ReadingSubmitted` event-log query
  — considered and not chosen; `data/publish-ledger.json` already exists
  for exactly this purpose and needs no extra live call.

## 9. How committed data reaches the deployed page

`web/` has no build output checked in to inspect, so this was resolved by
reading `web/`'s actual config (`vite.config.ts`, `package.json`,
`.gitignore`, `pnpm-lock.yaml`) and checking public documentation for the
exact packages pinned there: `vinext@1.0.0-beta.5` is Cloudflare's own
project (a standard Vite app that's API-compatible with Next.js, first-class
deployed to Cloudflare Workers); `@cloudflare/vite-plugin@1.37.1` is the
real, public, documented Cloudflare package already wired into
`vite.config.ts`. No `wrangler.toml`/`wrangler.json` is checked in —
`package.json`'s `"start": "wrangler dev --config dist/server/wrangler.json"`
confirms it's generated by the build, not authored by hand.

**Confirmed, from Cloudflare's own documentation:**
- Files placed in a project's `public/` directory (`web/public/` already
  exists, holds `favicon.svg`, and is not gitignored) are copied into the
  deployed Worker's static asset collection automatically, no `assets`
  config needed for the common case.
- They're served at runtime at the same relative path they had under
  `public/` — client-side `fetch('/data/whatever.json')` gets the file
  back directly from Cloudflare's edge, without invoking Worker code at
  all. This has no live-RPC-style failure mode — the same reliability
  class as any other static asset on the page (the favicon, the JS bundle
  itself), strictly more reliable than an RPC call to a public testnet
  endpoint.
- Real platform limits: 25 MiB per file, 20,000 files per Worker version
  on the free plan (100,000 on paid). All ~1,448 in-scope raw metric files
  would fit *inside* this limit on file count alone — the practical case
  against shipping them raw isn't a platform ceiling, it's that each raw
  file carries fields this page never uses (`sourceFiles`,
  `hashAlgorithm`, `computedAt`), and fetching per-file instead of one
  small aggregate per metric means far more round trips than necessary.

**Decision: a small Python aggregation step, owned by the pipeline side,
writes pre-generated files into `web/public/data/`; the Cloudflare/Vite
build itself does nothing new.**

- One aggregate file per in-scope metric (`ERCOT_HBNORTH_DA_AVG.json`,
  `ERCOT_WEST_NORTH_DA_BASIS.json`, `ERCOT_LOAD_WEIGHTED_DA_INDEX.json`,
  `ERCOT_HBWEST_NEG_INTERVALS.json`), each an array sorted by `dayKey`,
  trimmed to only what the page renders: `dayKey`, `marketDay`, `value`,
  `sourceHash`, and (joined from `data/publish-ledger.json`) `txHash` —
  `null` where no ledger entry exists for that metric-day, which is the
  common case today (most local metric-days were never submitted).
- This script lives with the rest of the pipeline tooling (this repo's
  root, alongside `fetch_ercot.py`/`analyse_metrics.py`/`finalize.py`),
  not inside `web/` — it's pipeline-owned logic operating on
  pipeline-owned files (`data/metrics/*.json`, `data/publish-ledger.json`),
  the same ownership split the rest of this repo already draws.
- Its *output* — the small aggregate JSON files — is committed to git
  under `web/public/data/`, the only thing this adds under `web/` (a new
  path; nothing existing is edited), refreshed by re-running the script by
  hand whenever new data is published/finalized. This is the exact same
  hand-off shape `data/publish-ledger.json` already uses (one side
  commits a derived artifact; the other side reads it as
  committed truth, no live cross-repo dependency at build or deploy time).
- **Why not a JS/Node prebuild step inside `web/`'s own build script
  instead** (e.g. reading `../data/...` at each Cloudflare deploy):
  rejected because it would require the Cloudflare project's configured
  build root to check out the whole monorepo (not just `web/`) at deploy
  time — a fact about the Cloudflare project's configuration this
  investigation could not verify (no dashboard access, and the checked-in
  config files don't state a build root). The git-committed-output
  approach has no such dependency: by the time Cloudflare builds
  anything, the aggregate files are already sitting in `web/public/`,
  checked in like any other tracked file.

## 10. Non-goals for this document

Exactly how many decimal places, which icon set, or the precise copy of
each state's label are implementation details, not spec decisions — the
table in §4 fixes the four states and their meaning; wording and icon
choice may vary as long as MISMATCH remains visually unmistakable from the
other three.
