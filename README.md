# GRIDFLEX pipeline — ERCOT data

Turns public ERCOT market data into the numbers our contracts settle on.

## Setup (once)

    pip install -r requirements.txt
    cp .env.example .env
    # open .env and paste your GridStatus API key

## Run

    export $(cat .env | xargs)        # mac / linux
    python fetch_ercot.py             # yesterday only
    python fetch_ercot.py --days 30   # last 30 days
    python fetch_ercot.py --days 365 --skip-fuelmix

On Windows PowerShell, set the key with:

    $env:GRIDSTATUS_API_KEY = "your_key_here"

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

**Feed metrics — published, shown on the site, never settled against:**

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

Fetches are chunked by calendar month, so a long range produces several files
in `data/raw/`. Every metric record lists the exact files it depends on, in
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

## Data source

GridStatus.io hosted API, which redistributes public ERCOT market data.
Direct ERCOT API access (api.ercot.com) is the production path; it is
geo-blocked from the UK, which is why we source via GridStatus for now.

Datasets used:
- `ercot_spp_day_ahead_hourly` — coverage from 2010-12-01, hourly
- `ercot_spp_real_time_15_min` — 15-minute
- `ercot_fuel_mix` — 5-minute

Free plan allows 500,000 rows/month and 1 request per second. Always filter
by location. The cache in `data/raw/` means re-runs cost nothing.

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
is published and shown on the site; it doesn't settle anything yet. A
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
load zones (LZ_*) are where consumption is metered and where load settles. If
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
