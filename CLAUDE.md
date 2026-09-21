# GRIDFLEX

Onchain power derivatives venue, built for the **OKX Dev Day 2026** hackathon
(track: X Layer, tokenized stocks and RWA). Online build period 17-25
September 2026, submission 25 September, live finale in Singapore 6 October.

**What it is:** we publish verified ERCOT power market data onchain with a
hash of the source, then list cash-settled contracts that settle against it.

**Never describe this as tokenized energy.** It is a derivatives venue —
nothing is redeemable for electricity. Get this wrong in the pitch, docs, or
code comments and it misrepresents the product.

## Architecture and ownership

- This repo is the data pipeline plus the GRIDFLEX web app: fetch ERCOT
  data, compute metrics, write metric files, and render the feed and
  verification UI.
- I (the user) own: the pipeline, metric definitions, market design, the
  pitch, `build_feed_data.py`, and — within `web/` —
  `web/components/feed-panel.tsx`, `web/lib/feed-data.ts`,
  `web/lib/feed-verification.ts`, and the design system for the whole
  `web/` app.
- A teammate (David) owns: `contracts/`, `web/components/web3-provider.tsx`,
  `web/components/trade-panel.tsx`, `web/components/wallet-button.tsx`, and
  `web/components/market-live-data.tsx` (thin display glue over his
  `useWeb3` hook — introduced in the same frontend merge as the other three).
  **Never edit these without presenting a plan first and getting explicit
  go-ahead** — narrower than a blanket ban, but nothing changes there
  without sign-off.
- The oracle (`GridOracle`) is deployed on X Layer testnet at the address in
  `shared/addresses.json` (currently
  `0x970cefFC0e75bCa245F3337715992ad520A4D561`). That file is the source of
  truth for all deployed addresses — don't hardcode an address anywhere
  else; read it from there. `shared/oracle-interface.md` is the frozen
  struct/function/event spec both sides build against; `shared/deployment.md`
  covers how David deploys.

## Hard rules

- **Never open, print, cat, or commit `.env`.** It holds the live
  `GRIDSTATUS_API_KEY`. It's already in `gitignore`. If a task seems to
  require seeing the key, stop and ask instead.
- **Always cache raw API responses to `data/raw/` before processing.**
  `fetch()` in `fetch_ercot.py` does this and skips re-fetching when the
  cache file exists — route all fetches through it. Don't delete files
  under `data/raw/` to force a re-fetch unless asked; re-fetching spends
  metered row budget.
- **GridStatus free plan: 1 request/second, 500,000 rows/month.** Always
  filter by location. `RATE_LIMIT_SLEEP = 1.5` enforces the rate limit after
  every live fetch — don't lower it, parallelize fetches, or retry-loop
  without a sleep.
- **Contract metrics require a complete market day.** A partial day
  (missing hourly/interval rows) must be skipped and logged, never
  averaged over the rows present — a half-day value settling a contract is
  a real-money bug. `EXPECTED_ROWS` is the completeness check; preserve it
  in any refactor.
- **Fuel mix is display only and tolerates 95% coverage.** It's a feed, not
  a settlement metric — don't hold it to the same completeness bar as the
  contract metrics, and don't promote it to contract status without an
  explicit decision to do so.

## Data source

GridStatus.io hosted API, redistributing public ERCOT data. Direct ERCOT API
access is geo-blocked from the UK, which is why we go through GridStatus.

## Metric decision — settled

The MVP has **two contract metrics**: `ERCOT_HBNORTH_DA_AVG` and
`ERCOT_WEST_NORTH_DA_BASIS`. These are the only two markets settle against.

`ERCOT_LOAD_WEIGHTED_DA_INDEX` (the statewide load-weighted day-ahead price)
and `ERCOT_HBWEST_NEG_INTERVALS` (negative real-time interval count) are
**feed data only** — published, shown on the site, never settled against.
`ERCOT_HBWEST_NEG_INTERVALS` sits at zero on ~61% of days, which is why it
was rejected as a contract metric in the first place. A contract on the
statewide index is the next listing after the hackathon — not in scope for
the MVP, don't build toward it as if it were.

`shared/metrics.md` is the full methodology reference for all four metrics
and states clearly which two are contract vs feed. If a task touches metric
definitions or settlement logic, check it against that document.

## Metric file schema — no timestamps as identifiers

Metric files use `dayKey` (uint32, `YYYYMMDD`, e.g. `20260908`) as the
identifier the oracle stores and markets look up, plus `marketDay` (ISO
date string) for humans and `marketDayStartUtc`/`marketDayEndUtc` (true UTC
instants of Central midnight to Central midnight, computed from the actual
interval data — 23h on the spring-forward day, 25h on the fall-back day).

There is **no `periodStart`/`periodEnd`**, and never re-add them, even as
aliases. The prior scheme stored midnight UTC of the Central date as
`periodStart` — an instant that is *not* the same as Central midnight (for
8 September it was 2026-09-07 19:00 Central), so anything that converted it
back to Central got the wrong day. A field that looks like a timestamp but
is actually a day identifier is exactly that trap; `dayKey` exists so there
is nothing to misinterpret. See `tests/test_market_day.py` for the proof.

Contracts cannot settle on the two DST changeover days each year — those
days fail the completeness check (23 or 25 hourly rows, not 24) and are
skipped entirely, by design. This is documented as a known limitation in
`shared/metrics.md`, not a bug to fix.

## Agent skills

### Issue tracker

Local markdown files under `.scratch/<feature-slug>/`, gitignored — never
pushed to either remote (the repo is public on a friend's account). See
`docs/agents/issue-tracker.md`.

### Domain docs

Skipped — `shared/*.md` already serves as domain documentation
(methodology, oracle interface, publish/finalize/feed specs). No separate
CONTEXT.md/ADRs.
