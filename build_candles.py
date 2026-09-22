"""
GRIDFLEX -- candlestick data builder
=====================================

Builds real OHLC candlestick series for the /trade page's chart, at
HB_NORTH (the Texas power price's hub, the only one the site shows; HB_WEST
too with --west-hub), from two ERCOT datasets:

  ercot_lmp_by_settlement_point   5-minute SCED dispatch LMPs -- real
                                   intra-bar variation, used to build the
                                   15m and 1h candles.
  ercot_spp_real_time_15_min      15-minute settlement prices -- one value
                                   per interval, used to build 4h/1d/1w
                                   (coarse enough that a 15-minute step
                                   size is a real, not flattened, input).

Why two datasets: ERCOT's real-time *settlement* price
(ercot_spp_real_time_15_min) is one weighted value per 15-minute interval,
so a candle built at 15-minute resolution FROM it has open=high=low=close
-- an honest flat bar, but a flat bar renders as a dash, not a candle.
ercot_lmp_by_settlement_point carries the underlying 5-minute SCED dispatch
LMPs that the 15-minute settlement price is itself an average of, so a 15m
or 1h candle built from three or twelve of those real dispatch ticks has
real open/high/low/close variation instead of a fabricated one. Reuses
fetch_ercot.py's fetch()/get_client()/to_central_day() so caching and
US/Central handling stay identical to the rest of the pipeline -- this is
a display feed built the same way the contract metrics are, not a
separate data source.

The coarser timeframes (4h/1d/1w) are real aggregates of the 15-minute
settlement prices: open = first price in the period, close = last, high =
max, low = min -- the same construction any exchange uses to build a
higher timeframe out of a lower-timeframe price series.

1d candles bucket on the Central calendar day (to_central_day), matching
how every other GRIDFLEX metric defines "a day". 1h/4h/15m bucket on fixed
UTC duration, which needs no DST handling because the bucket length itself
never changes. 1w groups the 1d series into ISO weeks.

This is a display feed, not a contract metric: there is no 96-row
completeness gate here (see EXPECTED_ROWS in fetch_ercot.py) -- a day with
a few missing intervals still contributes real high/low/open/close from
the intervals that exist, the same tolerance philosophy already applied to
fuel mix in shared/metrics.md.

Every candle file records which dataset built which timeframe (`sources`,
keyed by timeframe) so the chart can caption itself honestly instead of
naming one dataset for data that actually came from two.

Requests: one per dataset per location per run (fetch_ercot.fetch reads
every chunk the cache can't answer in a single request) - two by default.

Usage:
    python build_candles.py                # ~380 days of 15m data, HB_NORTH
    python build_candles.py --west-hub      # HB_WEST as well
    python build_candles.py --days 30       # shorter 15m-data range, cheaper
    python build_candles.py --five-min-days 90   # 5-min LMP window (default 90)
"""

import argparse
import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

import fetch_ercot
from fetch_ercot import CENTRAL, get_client, fetch, to_central_day

DATASET = "ercot_spp_real_time_15_min"
PRICE_COLUMN = "spp"

FIVE_MIN_DATASET = "ercot_lmp_by_settlement_point"
FIVE_MIN_PRICE_COLUMN = "lmp"
FIVE_MIN_DEFAULT_DAYS = 90

# The site's chart shows HB_NORTH only (design-brief.md §9: no hub switcher).
LOCATIONS = ["HB_NORTH"]
WEST_HUB = "HB_WEST"

OUT_DIR = Path("web/public/data/candles")

_EPOCH = pd.Timestamp("1970-01-01", tz="UTC")


def unix_seconds(ts: pd.Series) -> pd.Series:
    """
    Unix seconds from a tz-aware datetime Series, independent of whatever
    internal resolution pandas chose ([ns] vs [us]) when parsing the ISO
    strings read back from the JSON cache. `.astype('int64') // 10**9`
    silently assumes nanosecond resolution and is wrong (off by 1000x) the
    moment pandas parses at microsecond resolution instead, which it does
    for these particular timestamps -- caught by comparing against a live
    `time.time()` value, not by inspection.
    """
    return ((ts - _EPOCH) // pd.Timedelta(seconds=1)).astype("int64")


def resample_fixed(df: pd.DataFrame, freq: str, price_column: str) -> pd.DataFrame:
    """Real OHLC aggregation over a fixed-duration UTC bucket (15m/1h/4h)."""
    ts = pd.to_datetime(df["interval_start_utc"], utc=True)
    series = pd.Series(df[price_column].values, index=ts).sort_index()
    ohlc = series.resample(freq, label="left", closed="left").ohlc().dropna()
    out = pd.DataFrame(
        {
            "t": unix_seconds(pd.Series(ohlc.index)),
            "o": ohlc["open"].values,
            "h": ohlc["high"].values,
            "l": ohlc["low"].values,
            "c": ohlc["close"].values,
        }
    )
    return out.reset_index(drop=True)


def resample_central_day(df: pd.DataFrame, price_column: str) -> pd.DataFrame:
    """Real OHLC aggregation over the Central calendar day (1d)."""
    tagged = to_central_day(df)
    ts = pd.to_datetime(tagged["interval_start_utc"], utc=True)
    tagged = tagged.assign(_ts=ts).sort_values("_ts")
    rows = []
    for day, group in tagged.groupby("market_day"):
        prices = group[price_column]
        rows.append(
            {
                "t": int(group["_ts"].iloc[0].timestamp()),
                "day": str(day),
                "o": float(prices.iloc[0]),
                "h": float(prices.max()),
                "l": float(prices.min()),
                "c": float(prices.iloc[-1]),
            }
        )
    return pd.DataFrame(rows).sort_values("t").reset_index(drop=True)


def resample_weeks(daily: pd.DataFrame) -> pd.DataFrame:
    """Group the 1d series (already Central-day aggregated) into ISO weeks."""
    if daily.empty:
        return daily
    dates = pd.to_datetime(daily["day"])
    iso = dates.dt.isocalendar()
    key = list(zip(iso["year"], iso["week"]))
    rows = []
    tmp = daily.assign(_key=key)
    for _key, group in tmp.groupby("_key", sort=True):
        group = group.sort_values("t")
        rows.append(
            {
                "t": int(group["t"].iloc[0]),
                "o": float(group["o"].iloc[0]),
                "h": float(group["h"].max()),
                "l": float(group["l"].min()),
                "c": float(group["c"].iloc[-1]),
            }
        )
    return pd.DataFrame(rows).sort_values("t").reset_index(drop=True)


def to_records(df: pd.DataFrame) -> list:
    return [
        {"time": int(r.t), "open": round(float(r.o), 2), "high": round(float(r.h), 2),
         "low": round(float(r.l), 2), "close": round(float(r.c), 2)}
        for r in df.itertuples()
    ]


def five_min_window_start(end_date: date, days: int) -> str:
    """Start of the 5-minute window: `days` back, moved forward to the next
    first-of-month so every chunk before the current month is a whole
    calendar month. A start that slid forward one day at a time would make
    a new, uncached first chunk every day and spend its rows again; aligned,
    those months come from the cache and only days that are not yet final
    (fetch_ercot.chunk_is_final) are fetched. The window therefore
    covers between days-31 and `days` days."""
    start = end_date - timedelta(days=days)
    if start.day != 1:
        start = (start.replace(day=1) + timedelta(days=32)).replace(day=1)
    return str(start)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2025-09-10",
                        help="15-min settlement data start date, matches the earliest cached chunk")
    parser.add_argument("--days", type=int, default=None,
                        help="override: fetch 15-min settlement data this many days back")
    parser.add_argument("--five-min-days", type=int, default=FIVE_MIN_DEFAULT_DAYS,
                        help="how many days of 5-min dispatch LMPs to fetch, for 15m/1h candles")
    parser.add_argument("--west-hub", action="store_true",
                        help=f"also build {WEST_HUB} candles (the site doesn't show them)")
    parser.add_argument("--plan", action="store_true",
                        help="dry run: print the GridStatus requests this run "
                             "would make and exit without making any")
    parser.add_argument("--max-requests", type=int, default=12,
                        help="refuse to fetch past this many GridStatus "
                             "requests in one run (default 12; 0 = no limit)")
    args = parser.parse_args()
    locations = LOCATIONS + ([WEST_HUB] if args.west_hub else [])
    fetch_ercot.request_budget = args.max_requests or None

    end_date = datetime.now(timezone.utc).date()
    end = str(end_date)
    start = str(end_date - timedelta(days=args.days)) if args.days else args.start
    five_min_start = five_min_window_start(end_date, args.five_min_days)

    print(f"GRIDFLEX candle builder @ {locations}")
    print(f"  {FIVE_MIN_DATASET} (15m, 1h): {five_min_start} -> {end}")
    print(f"  {DATASET} (4h, 1d, 1w): {start} -> {end}\n")

    if args.plan:
        total = 0
        for location in locations:
            for dataset, window_start in ((FIVE_MIN_DATASET, five_min_start), (DATASET, start)):
                spans = fetch_ercot.plan_requests(dataset, location, window_start, end)
                total += len(spans)
                print(f"{dataset} @ {location}: {len(spans)} request(s)")
                for span_start, span_end in spans:
                    print(f"    {span_start} -> {span_end}")
        print(f"\nPLAN ONLY - no requests were made. This run would make {total} "
              "GridStatus request(s).")
        return

    client = get_client()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for location in locations:
        print(f"{location}")

        df5, hash5, files5 = fetch(
            client, FIVE_MIN_DATASET, five_min_start, end, location=location
        )
        df5 = df5.dropna(subset=[FIVE_MIN_PRICE_COLUMN])
        # This dataset's primary key is (sced_timestamp_utc, location), so it
        # is real-time SCED dispatch only - no day-ahead rows to filter out.
        # Still worth asserting: a silently-added market column value here
        # would otherwise blend DAM prices into a "real-time" candle.
        markets = sorted(df5["market"].dropna().unique().tolist()) if "market" in df5 else []
        if markets and markets != ["REAL_TIME_SCED"]:
            raise SystemExit(
                f"{FIVE_MIN_DATASET} returned unexpected market value(s) {markets} "
                f"for {location} - expected only 'REAL_TIME_SCED'. Refusing to build "
                "candles from data that might mix in day-ahead prices."
            )
        df5 = df5.assign(_ts=pd.to_datetime(df5["interval_start_utc"], utc=True)).sort_values("_ts")

        m15 = resample_fixed(df5, "15min", FIVE_MIN_PRICE_COLUMN)
        h1 = resample_fixed(df5, "1h", FIVE_MIN_PRICE_COLUMN)

        df15, hash15, files15 = fetch(client, DATASET, start, end, location=location)
        # Sort on the parsed timestamp, not the raw column: a mix of cached
        # chunks (ISO strings read back from JSON) and a freshly-fetched
        # chunk (already Timestamp-typed) can leave interval_start_utc as a
        # mixed-type object column that sort_values can't compare directly.
        df15 = df15.dropna(subset=[PRICE_COLUMN])
        df15 = df15.assign(_ts=pd.to_datetime(df15["interval_start_utc"], utc=True)).sort_values("_ts")

        h4 = resample_fixed(df15, "4h", PRICE_COLUMN)
        d1 = resample_central_day(df15, PRICE_COLUMN)
        w1 = resample_weeks(d1)

        five_min_source = {
            "dataset": FIVE_MIN_DATASET,
            "priceColumn": FIVE_MIN_PRICE_COLUMN,
            "sourceHash": hash5,
            "sourceFiles": files5,
        }
        fifteen_min_source = {
            "dataset": DATASET,
            "priceColumn": PRICE_COLUMN,
            "sourceHash": hash15,
            "sourceFiles": files15,
        }

        payload = {
            "location": location,
            "hashAlgorithm": "sha256",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "candles": {
                "15m": to_records(m15),
                "1h": to_records(h1),
                "4h": to_records(h4),
                "1d": to_records(d1.drop(columns=["day"])),
                "1w": to_records(w1),
            },
            "sources": {
                "15m": five_min_source,
                "1h": five_min_source,
                "4h": fifteen_min_source,
                "1d": fifteen_min_source,
                "1w": fifteen_min_source,
            },
        }

        out_path = OUT_DIR / f"{location}.json"
        out_path.write_text(json.dumps(payload))
        counts = {tf: len(series) for tf, series in payload["candles"].items()}
        print(f"  wrote {out_path} -- {counts}")

    print(f"\nGridStatus requests this run: {fetch_ercot.requests_made}")
    if fetch_ercot.http_requests != fetch_ercot.requests_made:
        print(f"GridStatus HTTP requests sent (paged responses): {fetch_ercot.http_requests}")
    print(f"GridStatus rows fetched this run: {fetch_ercot.rows_fetched:,}")
    print(
        f"Row cost note: {FIVE_MIN_DATASET} costs ~288 rows/day per location "
        f"(--five-min-days), {DATASET} costs ~96 rows/day per location (--days); "
        "check GridStatus's monthly row allowance before widening either."
    )


if __name__ == "__main__":
    main()
