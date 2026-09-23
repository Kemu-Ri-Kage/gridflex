# GRIDFLEX technical reference

Developer detail moved out of the top-level [README](../README.md): how to
run the pipeline, how each metric is computed and hashed, and how the
contracts, web app, publisher and finalizer are operated.

## ERCOT data pipeline

Turns public ERCOT market data into the numbers our contracts settle on.

## Setup (once)

    python3 --version              # Python 3.10 or newer
    python3 -m pip install -r requirements.txt
    cp .env.example .env
    # open .env and paste your GridStatus API key

## Run

    export $(cat .env | xargs)        # mac / linux
    python fetch_ercot.py                 # yesterday and today
    python fetch_ercot.py --days 30       # last 30 days and today
    python fetch_ercot.py --fill-gaps     # also any day missing since the
                                          # latest complete day
    python fetch_ercot.py --feed-metrics  # also the feed-only metrics
    python fetch_ercot.py --fuel-mix      # also the fuel mix

On Windows PowerShell, set the key with:

    $env:GRIDSTATUS_API_KEY = "your_key_here"

By default only the Texas power price (North Hub day-ahead) is fetched, in
one request covering every day the cache can't answer. Today and the last 3
days before it (UTC) are re-fetched each run.
Everything older comes from the `data/raw/` cache, because settled prices
don't change. The current month is cached one file per day, so its earlier
days are never re-read. Past months keep their whole-month files. If a
re-fetched chunk's bytes changed upstream, the old version moves to
`data/raw/superseded/`, because published hashes cite those files. A reading
already published onchain is never rewritten.

To refresh everything the site shows and redeploy it in one go:

    ./refresh_data.sh              # fetch, rebuild feed + candles, build, deploy
    ./refresh_data.sh --no-deploy  # same, without the deploy

A routine refresh is three GridStatus requests, one per dataset, and about
1,300 rows (North Hub day-ahead prices for the last 3 days and today, about
100; 15-minute prices for the last 3 days, about 300; 5-minute prices for
the last 3 days, about 900), the same on any day of the month. Before
fetching, `refresh_budget.py` plans that cost from the raw cache, asks
GridStatus's `get_api_usage()` what is left of the month's allowance, and
stops the refresh if it wouldn't fit. `python refresh_budget.py --plan`
prints the plan without calling GridStatus. The script prints the requests
and rows it actually used at the end.

## What it produces

    data/raw/       raw API responses, cached. NOT committed.
    data/metrics/   one JSON per metric per day. Committed.

Each metric file is what `publish.py` will hand to the oracle contract:

    {
      "metricId":          "ERCOT_HBNORTH_DA_AVG",
      "dayKey":             20260908,
      "marketDay":          "2026-09-08",
      "marketDayStartUtc":  1788843600,
      "marketDayEndUtc":    1788930000,
      "value":              3957,
      "sourceHash":         "75999d01...",
      "sourceFiles":        ["ercot_spp_day_ahead_hourly__HB_NORTH__..."],
      "hashAlgorithm":      "sha256"
    }

`dayKey` is the identifier the oracle stores and markets look up — a plain
`YYYYMMDD` integer, not a timestamp, so there is no timezone conversion that
can shift it by a day. `marketDayStartUtc`/`marketDayEndUtc` are the true
UTC instants of Central midnight to Central midnight for that day, computed
from the actual data. There is no `periodStart`/`periodEnd` field — see
`shared/metrics.md` for why that scheme was replaced.

## Metrics

**MVP contract metrics — the only two things markets settle against:**

| metricId | Meaning | Unit |
|---|---|---|
| `ERCOT_HBNORTH_DA_AVG` | mean of 24 hourly day-ahead prices at HB_NORTH | USD/MWh x 100 |
| `ERCOT_WEST_NORTH_DA_BASIS` | daily mean HB_WEST day-ahead minus mean HB_NORTH day-ahead | USD/MWh x 100 |

**Feed metrics — published onchain, never settled against, not shown on the public site:**

| metricId | Meaning | Unit |
|---|---|---|
| `ERCOT_LOAD_WEIGHTED_DA_INDEX` | statewide load-weighted day-ahead price (see below). A contract on this is the next listing after the hackathon, not part of the MVP. | USD/MWh x 100 |
| `ERCOT_HBWEST_NEG_INTERVALS` | 15-min real-time intervals below zero at HB_WEST. Rejected as a contract metric — see "Metric decision" below. | count, 0-96 |
| `ERCOT_FUELMIX_<FUEL>` | share of daily generation by fuel | percent x 100 |

A "day" is a Central Prevailing Time calendar day, because that is how ERCOT
defines a market day. `dayKey` encodes it directly; `marketDayStartUtc`/
`marketDayEndUtc` are UTC unix seconds.

Queries pass `timezone="US/Central"` so that start/end mean Central midnights.
Without this, a UTC-day query straddles two market days and produces averages
over partial days. Any day that does not have its full row count (24 hourly,
96 quarter-hourly, 288 five-minute) is skipped and reported, never written —
which permanently excludes the two DST transition days each year from both
contract metrics. See `shared/metrics.md` for the full writeup.

## Verification

Fetches are chunked by calendar month, and by day while a month is still in
progress, so a long range produces several files in `data/raw/`. Every metric record lists the exact files it depends on, in
hash order, under `sourceFiles`. `sourceHash` is the SHA-256 of those files
concatenated in that order:

    cd data/raw && cat <the sourceFiles list, in order> | shasum -a 256

Use the listed files, not a glob. `data/raw/` accumulates overlapping chunks
from runs with different `--days` values, so `<dataset>__<location>__*.json`
matches more files than the metric actually used.

**Derived metrics hash every leg.** `ERCOT_WEST_NORTH_DA_BASIS` is West minus
North, so its hash covers both legs: `sha256(hash_west + hash_north)`.
`ERCOT_LOAD_WEIGHTED_DA_INDEX` covers all four zone price series plus the load
series, in fixed order. Hashing only some inputs to a number would let someone
verify half of it and believe they had verified all of it — worse than
publishing no hash at all.

Month chunking exists for three reasons: a year of 15-minute prices in one
response trips a brotli decode bug in the HTTP stack (reproduced, not a
fluke); a failure costs one month rather than the whole pull; and each chunk
caches separately so a re-run only fetches what is missing. The client also
sends `Accept-Encoding: gzip, deflate` to stay off the brotli path entirely.

SHA-256 rather than keccak256 so that anyone can verify with standard command
line tools rather than an Ethereum library. The contract stores it as bytes32
either way.

**What a third party can and cannot check.** `data/raw/` is not committed, so
the hash above is reproducible only by whoever holds the same response files.
What anyone can check without them is the number itself: the day's 24 hourly
prices are public, the rule is a plain mean, and `verify_reading.py`
re-reads them from GridStatus and recomputes it with the pipeline's own
functions, then compares with the oracle:

```bash
python3 verify_reading.py --day-key 20260908                # chain vs committed file
python3 verify_reading.py --day-key 20260908 --fetch        # plus a recompute from GridStatus
python3 verify_reading.py --day-key 20260812 --metric ERCOT_WEST_NORTH_DA_BASIS --fetch
```

It prints three checks as PASS, FAIL or SKIP: the oracle's value and hash
against the committed file; the committed hash against the raw files, when
they are present; and the recomputed value against the oracle. Read-only,
no wallet, exit status 1 on any FAIL. `--fetch` needs `GRIDSTATUS_API_KEY`
and spends 24 rows (48 for the basis) of the monthly allowance.

## Data source

GridStatus.io hosted API, which redistributes public ERCOT market data.
Direct ERCOT API access (api.ercot.com) is the production path; it is
geo-blocked from the UK, which is why we source via GridStatus for now.

Datasets used:
- `ercot_spp_day_ahead_hourly` — coverage from 2010-12-01, hourly
- `ercot_spp_real_time_15_min` — 15-minute
- `ercot_fuel_mix` — 5-minute

Free plan allows 500,000 rows/month and 1 request per second. Always filter
by location. The cache in `data/raw/` means re-runs only re-read the last 3
days.

## Adding another zone

Change the `DAY_AHEAD` and `REAL_TIME` blocks at the top of `fetch_ercot.py`.
GridStatus carries PJM, CAISO, MISO, NYISO, ISONE and SPP through the same
client, so a new zone is a dataset id, a location, and a metricId prefix.

## Metric decision, 10 September — settled

A year of data settled the open question. `ERCOT_HBWEST_NEG_INTERVALS` sits at
exactly zero on ~61% of days, so every candidate threshold collapses to the
same split and the question has no uncertain answer. It stays as a feed
statistic, not a contract.

The second contract metric is `ERCOT_WEST_NORTH_DA_BASIS` — the West-to-North
day-ahead spread. It measures the same West Texas congestion, splits close to
50/50 at a sensible threshold, and moves meaningfully day to day. Congestion
rights trade on exactly this spread in the real market.

**The MVP ships with exactly these two contract metrics** —
`ERCOT_HBNORTH_DA_AVG` and `ERCOT_WEST_NORTH_DA_BASIS` — and nothing else
settles against. `ERCOT_LOAD_WEIGHTED_DA_INDEX` (added after this decision;
see below) is feed data for the hackathon build. A contract on the
statewide index is the next listing after the hackathon.

Run `python analyse_metrics.py` to reproduce the comparison.

## The statewide index

**Feed metric, not a contract in the MVP.** `ERCOT_LOAD_WEIGHTED_DA_INDEX`
is published onchain; it doesn't settle anything yet. A
contract on it is the next listing after the hackathon.

`ERCOT_LOAD_WEIGHTED_DA_INDEX` answers "what did Texas actually pay for power
today". Total cost divided by total volume:

    index = SUM over hours,zones ( price[h,z] * load[h,z] )
            ---------------------------------------------
            SUM over hours,zones ( load[h,z] )

Four load zones — LZ_NORTH, LZ_SOUTH, LZ_WEST, LZ_HOUSTON — priced from
`ercot_spp_day_ahead_hourly`, weighted by actual hourly consumption from
`ercot_load_by_forecast_zone`.

Three choices worth defending:

**Weights are never hardcoded.** They come from ERCOT's published hourly load,
so they track real shifts in demand — Houston's summer afternoon peak, West
Texas's data-centre growth — with nobody maintaining a table. Each stored
reading carries that day's realised `loadWeights` so the calculation can be
checked after the fact.

**Load zones, not trading hubs.** Hubs (HB_*) are pricing reference points;
load zones (LZ_*) are where consumption is metred and where load settles. If
you are weighting by consumption, those are the prices the weights belong to.

**Cost over volume, not an average of hourly averages.** Summing cost and
volume across the whole day weights peak hours more heavily, which is correct:
more megawatt-hours changed hands at 3pm than at 4am.

An hour is only counted if all four zones have both a price and a load figure.
A missing zone is dropped rather than reweighted across the rest, because
silently reweighting biases the index toward whoever is left.

### Resolution floor

There is no 1-minute Texas power price, and this is not a data limitation.
ERCOT's dispatch engine clears roughly every 5 minutes and settles on 15-minute
intervals, so prices are constructed at those intervals and no finer.

| Series | Finest resolution |
|---|---|
| SCED locational prices | 5 minutes |
| Real-time settlement prices | 15 minutes |
| Day-ahead prices | 1 hour |
| Load by zone | 1 hour |
| Fuel mix | 5 minutes |

Interpolating to a finer grid is fine for a chart and never acceptable for
settlement: settling on an interpolated price means settling on a number ERCOT
never published, which destroys the verification argument.

## Solidity MVP

The Foundry project in `contracts/` contains:

- `GridOracle`: a single authorised testnet reporter submits a signed `int256`
  value under `(metricId, dayKey)` and anyone can finalise it after the oracle
  dispute window;
- `BinaryMarket`: mints a fully collateralised YES+NO set, swaps outcomes in a
  zero-fee constant-product pool, resolves strictly above a signed threshold,
  and redeems the winner one-for-one;
- a mandatory cancellation path: if no oracle reading was submitted after the
  market grace period, each YES and NO redeems for 0.5 collateral (rounded
  down), so a complete set returns one full unit and no user's position is
  permanently trapped; any submitted reading can instead be finalised by anyone;
- `MarketFactory`, `OutcomeToken`, and public-mint `MockUSDT` for the testnet
  demonstration.

Only `ERCOT_HBNORTH_DA_AVG` and `ERCOT_WEST_NORTH_DA_BASIS` may be used to
construct MVP markets. The market's `threshold` and the oracle's `value` are
both `int256`, because the West–North basis is frequently negative. The demo
pool seed defaults to 10,000 MockUSDT and the swap fee is zero.

Run the contract suite and regenerate the committed ABIs:

```bash
cd contracts
forge fmt --check
forge test
python3 scripts/export_abi.py
```

## Web interface

`web/` is a Vinext/React application using viem. It needs no environment to
run: contract addresses and the list of markets come from
`web/public/data/addresses.json`, written from `shared/addresses.json` by
`build_feed_data.py`. The order ticket trades whichever listed market is
selected. With a wallet on X Layer testnet it can get demo collateral, buy YES
or NO (a complete set is minted and the other side swapped in, in one action),
resolve or cancel after trading closes, and redeem. Switch position swaps
YES for NO or NO for YES with the same slippage protection and deadline; it
changes side and is not a sale, because the markets have no exit into mUSDT
before settlement. `web/.env.example` lists the optional overrides.

```bash
cd web
pnpm install --frozen-lockfile
pnpm lint
pnpm build
pnpm dev
```

### Feed page

A read-only section of the app (no wallet required) built to prove the pitch's core claim: every
number shown is provably on-chain. It never depends on a live RPC call to render — two committed
sources drive it. `build_feed_data.py` reads `data/metrics/*.json` (value, `sourceHash`) and
`data/publish-ledger.json` (`txHash`) and writes small per-metric files into `web/public/data/`;
run it after any `publish.py`/`finalize.py` run to refresh what the page shows:

```bash
python3 build_feed_data.py
```

The West–North basis chart and the verified-readings table both render from those committed
files. The only thing that touches the chain live is a per-row verification check — a fresh
`getReading()` call compared against the committed value and `sourceHash` — which drives a single
indicator per row, always exactly one of four states:

| State | Meaning |
|---|---|
| `VERIFIED` | the live check matched the committed file |
| `UNVERIFIED` | no live check has succeeded yet this session |
| `LAST VERIFIED {t} ago` | an earlier check matched; the most recent one failed to *reach* the chain |
| `MISMATCH` | the chain responded but disagrees with the committed file |

`MISMATCH` is a distinct outcome from a transport failure, not a variant of one: it is never
retried and never degrades into `LAST VERIFIED`, because doing so would launder the one finding
this page exists to surface into an ordinary network blip. See `shared/feed-spec.md` for the full
design and the reasoning behind each of these decisions.

## X Layer testnet

- Chain ID: `1952` (mainnet `196` is rejected by the deployment scripts)
- RPC: `https://testrpc.xlayer.tech/terigon`, with
  `https://xlayertestrpc.okx.com/terigon` as the backup. The web app tries
  them in that order (`XLAYER_TESTNET_RPC_URLS` in `web/lib/contracts.ts`).
- Explorer: OKLink, `https://www.oklink.com/x-layer-testnet` (`/tx/<hash>`,
  `/address/<address>`)
- Faucet: `https://web3.okx.com/xlayer/faucet`
- Deployment instructions: [`shared/deployment.md`](../shared/deployment.md)

Core deployment from `0x27Aad02480f1DC01ebCb53fd7321a4629BCbe902`:

| Contract | Address | Deployment transaction |
|---|---|---|
| `GridOracle` | [`0x970cefFC0e75bCa245F3337715992ad520A4D561`](https://www.oklink.com/x-layer-testnet/address/0x970cefFC0e75bCa245F3337715992ad520A4D561) | [`0xf77f4f55d80dc42a0ad657c8c94af21bea395ea462e8727c1941444d93a9abdf`](https://www.oklink.com/x-layer-testnet/tx/0xf77f4f55d80dc42a0ad657c8c94af21bea395ea462e8727c1941444d93a9abdf) |
| `MockUSDT` | [`0xA5A5e9eB64d4a9414AA09d887E284d8F2b3b217A`](https://www.oklink.com/x-layer-testnet/address/0xA5A5e9eB64d4a9414AA09d887E284d8F2b3b217A) | [`0xcacbb52fcf1e37d5582b16e78a954d985b1ba4b1ceb453301ad4962f5f1df891`](https://www.oklink.com/x-layer-testnet/tx/0xcacbb52fcf1e37d5582b16e78a954d985b1ba4b1ceb453301ad4962f5f1df891) |
| `MarketFactory` | [`0xE52189873eb34A5cdbeE5ACAD2d227F2a65CC3A9`](https://www.oklink.com/x-layer-testnet/address/0xE52189873eb34A5cdbeE5ACAD2d227F2a65CC3A9) | [`0x4cbea7ff136d99d17c21055af295d2c78f9ba0b55df789184e8a11ccad04e37c`](https://www.oklink.com/x-layer-testnet/tx/0x4cbea7ff136d99d17c21055af295d2c78f9ba0b55df789184e8a11ccad04e37c) |

The onchain checks confirm that all three addresses contain bytecode, the oracle reporter is the
deployer above, the oracle dispute window is `3600`, collateral decimals are `6`, and the
trade-safe factory starts with zero markets. Its runtime bytecode exactly matches the committed
source build. Machine-readable values and the superseded factory record live in
`shared/addresses.json`.

Use a dedicated testnet wallet. Never commit `.env`, place a private key in a
command, or include it in a ZIP. Private keys are stored outside this repository in an encrypted
keystore; only public addresses and transaction hashes are shared.

### Publish oracle readings safely

`publish.py` is dry-run-only unless `--live` is supplied. For the reporter wallet, prefer the
encrypted keystore already used for deployment:

```bash
export REPORTER_KEYSTORE_PATH=/absolute/path/to/gridflex-deployer
python3 publish.py --check
python3 publish.py --limit 3
python3 publish.py --live --limit 3
```

Both commands that access the key request its password without echoing it. Live mode checks chain
ID `1952`, contract bytecode, and the oracle's immutable reporter before showing a second explicit
`yes` confirmation. The committed `data/publish-ledger.json` makes normal reruns idempotent. Because
multiple operators may publish from separate working copies, live mode additionally checks every
candidate reading on-chain and recovers missing ledger rows before sending; stale local state therefore
cannot silently reset an existing reading's one-hour dispute window. Local human-readable logs are written
under gitignored `logs/`.

### Finalize oracle readings

`finalize()` is permissionless — no reporter key, no `onlyReporter` check. Anyone holding testnet
OKB for gas can finalize a reading once its one-hour dispute window has passed, using their own
wallet (`FINALIZER_KEYSTORE_PATH` or `FINALIZER_PRIVATE_KEY`, same pluggable model as the reporter
key, never the reporter key itself):

```bash
python3 finalize.py --check
python3 finalize.py --verify
python3 finalize.py --limit 3
python3 finalize.py --live --limit 3
```

`--check` confirms chain ID `1952`, contract bytecode, and the finalizer wallet's balance.
`--verify` is read-only and needs no key or wallet at all: with no flags it checks the six demo
markets in `shared/demo-markets.md` and reports `PUBLISHED, FINALIZED`, `PUBLISHED, not finalized
(time remaining)`, or `NOT PUBLISHED` for each; `--metric NAME --day-key YYYYMMDD` checks any single
reading instead. It exits non-zero unless every checked reading is already finalized, so it works
as a pre-demo gate, not just a report. A bare run (no `--live`) is always a dry run, printing what
would finalize. `--live` finalizes everything currently eligible, checked fresh against the chain
every time (never against the ledger's cached state) and isolates each reading independently — one
revert never blocks the rest of the batch. See `shared/finalize-spec.md` for the full design.

### Return the pool's collateral after settlement

Each market is seeded with 10,000 mUSDT that only its provider can take back,
with `claimLiquidity()`, once the market has resolved or cancelled (the
winning reserve after a resolution, half of each reserve after a
cancellation). Nothing else releases it. `claim_liquidity.py` lists every
listed market's pool and what a claim pays, and with `--live` sends the
claims that belong to the signer (finalizer-key convention, typed `yes`):

```bash
python3 claim_liquidity.py
python3 claim_liquidity.py --live
```

### Verify the contracts' source on OKLink

`contracts/scripts/verify_contracts.sh` submits the source of every deployed
contract in `shared/addresses.json` to OKLink's X Layer testnet verifier, so
an address page shows Solidity rather than bytecode. It needs an OKLink API
key and Foundry, sends no transactions, and skips what is already verified:

```bash
OKLINK_API_KEY=... contracts/scripts/verify_contracts.sh --dry-run
OKLINK_API_KEY=... contracts/scripts/verify_contracts.sh
```

### Reading tomorrow's price the afternoon it appears

`fetch_ercot.py` reads up to and including today's market day (UTC). The day
a live market settles on is tomorrow's, and ERCOT publishes its day-ahead
prices about 13:30 Texas time, 18:30 UTC in summer. `--tomorrow` (also on
`refresh_data.sh`) extends the window by one day so that reading can be
published the same evening; before ERCOT has published, the day has no rows
and is skipped. The dated sequence for every live market is in
`docs/OPS-RUNBOOK.md`.

### Request guards on direct runs

`refresh_data.sh` is not the only way to spend the GridStatus allowance; a
direct `fetch_ercot.py` or `build_candles.py` run is. Both now plan every
request from the raw cache before sending one, the same
`plan_chunks -> chunks_to_fetch -> request_spans` path `fetch()` follows,
and `refresh_budget.py` plans with the same functions, so the allowance
guard never budgets a smaller operation than the fetch that follows it.

```bash
python3 fetch_ercot.py --plan --days 3 --fill-gaps --tomorrow   # no API call at all
python3 fetch_ercot.py --usage                                   # one get_api_usage() call, nothing else
python3 fetch_ercot.py --days 400 --feed-metrics                 # refused: over --max-requests 10
python3 fetch_ercot.py --days 400 --feed-metrics --max-requests 120
python3 build_candles.py --plan
python3 refresh_budget.py --tomorrow                             # the budget refresh_data.sh --tomorrow checks
```

`--max-requests` defaults to 10 (`fetch_ercot.DEFAULT_MAX_REQUESTS`): a
routine refresh is one request per dataset and a full 31-day feed-metrics
run is ten. A plan above it stops before the first request with the count
and a message; raising it is the deliberate act. On a fresh clone with no
`data/raw/`, the first `build_candles.py` is a full-history pull of about
16 requests and needs `--max-requests 20` once; after that the cache makes
a refresh two requests.
