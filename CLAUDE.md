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

- This Python repo is the data pipeline: fetch ERCOT data, compute metrics,
  write metric files.
- A teammate builds the Solidity side on X Layer testnet (chain 1952): an
  oracle contract that reads these metric files, plus a binary outcome
  market contract. There will be a `contracts/` folder later —
  **never edit anything in it**, that's not my scope.
- I (the user) own: the pipeline, the metric definitions, the market design,
  and the pitch. Not the Solidity.

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

## Open question — not decided

`ERCOT_HBWEST_NEG_INTERVALS` (count of negative 15-min real-time intervals at
HB_WEST) returns zero on most summer days, which makes a poor contract —
little to no variance to bet on. Candidate alternative: a **HB_WEST /
HB_NORTH basis spread** instead. Don't treat either as settled; flag this
when it's relevant rather than assuming the current metric ships as-is.
