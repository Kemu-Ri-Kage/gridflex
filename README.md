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
      "metricId":    "ERCOT_HBNORTH_DA_AVG",
      "periodStart": 1788739200,
      "periodEnd":   1788825600,
      "value":       3000,
      "sourceHash":  "9f2b...",
      "hashAlgorithm": "sha256"
    }

## Metrics

| metricId | Meaning | Unit |
|---|---|---|
| `ERCOT_HBNORTH_DA_AVG` | mean of 24 hourly day-ahead prices at HB_NORTH | USD/MWh x 100 |
| `ERCOT_WEST_NORTH_DA_BASIS` | daily mean HB_WEST day-ahead minus mean HB_NORTH day-ahead | USD/MWh x 100 |
| `ERCOT_HBWEST_NEG_INTERVALS` | 15-min real-time intervals below zero at HB_WEST (feed only, see below) | count, 0-96 |
| `ERCOT_FUELMIX_<FUEL>` | share of daily generation by fuel (feed only) | percent x 100 |

A "day" is a Central Prevailing Time calendar day, because that is how ERCOT
defines a market day. Timestamps are stored as UTC unix seconds.

Queries pass `timezone="US/Central"` so that start/end mean Central midnights.
Without this, a UTC-day query straddles two market days and produces averages
over partial days. Any day that does not have its full row count (24 hourly,
96 quarter-hourly, 288 five-minute) is skipped and reported, never written.

## Verification

Fetches are chunked by calendar month, so a long range produces several files
in `data/raw/`. `sourceHash` is the SHA-256 of those chunk files concatenated
in date order:

    cat data/raw/<dataset>__<location>__*.json | shasum -a 256

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

## Metric decision, 10 September

A year of data settled the open question. `ERCOT_HBWEST_NEG_INTERVALS` sits at
exactly zero on ~61% of days, so every candidate threshold collapses to the
same split and the question has no uncertain answer. It stays as a feed
statistic, not a contract.

The second contract metric is `ERCOT_WEST_NORTH_DA_BASIS` — the West-to-North
day-ahead spread. It measures the same West Texas congestion, splits close to
50/50 at a sensible threshold, and moves meaningfully day to day. Congestion
rights trade on exactly this spread in the real market.

Run `python analyse_metrics.py` to reproduce the comparison.
