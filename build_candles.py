"""
GRIDFLEX -- candlestick data builder
=====================================

Builds real OHLC candlestick series for the /trade page's chart, from ERCOT
real-time 15-minute settlement prices (`ercot_spp_real_time_15_min`) at
HB_NORTH and HB_WEST. Reuses fetch_ercot.py's fetch()/get_client()/
to_central_day() so caching and US/Central handling stay identical to the
rest of the pipeline -- this is a display feed built the same way the
contract metrics are, not a separate data source.

Each 15-minute interval carries one settlement price, not a full OHLC tick
series, so the native 15m "candle" is open=high=low=close=price -- an
honest flat bar, not fabricated intra-interval variation. The coarser
timeframes (1h/4h/1d/1w) are real aggregates of those 15-minute prices:
open = first price in the period, close = last, high = max, low = min --
the same construction any exchange uses to build a higher timeframe out of
a lower-timeframe price series.

1d candles bucket on the Central calendar day (to_central_day), matching
how every other GRIDFLEX metric defines "a day". 1h/4h bucket on fixed UTC
duration, which needs no DST handling because the bucket length itself
never changes. 1w groups the 1d series into ISO weeks.

This is a display feed, not a contract metric: there is no 96-row
completeness gate here (see EXPECTED_ROWS in fetch_ercot.py) -- a day with
a few missing intervals still contributes real high/low/open/close from
the intervals that exist, the same tolerance philosophy already applied to
fuel mix in shared/metrics.md.

Usage:
    python build_candles.py                # ~380 days, both hubs
    python build_candles.py --days 30       # shorter range, cheaper
"""

import argparse
import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from fetch_ercot import CENTRAL, get_client, fetch, to_central_day

DATASET = "ercot_spp_real_time_15_min"
PRICE_COLUMN = "spp"
LOCATIONS = ["HB_NORTH", "HB_WEST"]

OUT_DIR = Path("web/public/data/candles")

# Bound file size for the finest timeframe; coarser ones stay full-range.
FIFTEEN_MIN_WINDOW_DAYS = 120

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


def build_native_15m(df: pd.DataFrame) -> pd.DataFrame:
    """One row per real interval: t (unix seconds), o=h=l=c=price."""
    ts = pd.to_datetime(df["interval_start_utc"], utc=True)
    out = pd.DataFrame(
        {
            "t": unix_seconds(ts),
            "o": df[PRICE_COLUMN],
            "h": df[PRICE_COLUMN],
            "l": df[PRICE_COLUMN],
            "c": df[PRICE_COLUMN],
        }
    )
    return out.sort_values("t").drop_duplicates("t").reset_index(drop=True)


def resample_fixed(df: pd.DataFrame, freq: str) -> pd.DataFrame:
    """Real OHLC aggregation over a fixed-duration UTC bucket (1h/4h)."""
    ts = pd.to_datetime(df["interval_start_utc"], utc=True)
    series = pd.Series(df[PRICE_COLUMN].values, index=ts).sort_index()
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


def resample_central_day(df: pd.DataFrame) -> pd.DataFrame:
    """Real OHLC aggregation over the Central calendar day (1d)."""
    tagged = to_central_day(df)
    ts = pd.to_datetime(tagged["interval_start_utc"], utc=True)
    tagged = tagged.assign(_ts=ts).sort_values("_ts")
    rows = []
    for day, group in tagged.groupby("market_day"):
        prices = group[PRICE_COLUMN]
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2025-09-10",
                        help="start date, matches the earliest cached chunk")
    parser.add_argument("--days", type=int, default=None,
                        help="override: fetch this many days back from yesterday")
    args = parser.parse_args()

    end_date = datetime.now(timezone.utc).date()
    end = str(end_date)
    start = str(end_date - timedelta(days=args.days)) if args.days else args.start

    print(f"GRIDFLEX candle builder: {DATASET} @ {LOCATIONS}, {start} -> {end}\n")
    client = get_client()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    window_start_t = int(
        (pd.Timestamp(end_date, tz="UTC") - pd.Timedelta(days=FIFTEEN_MIN_WINDOW_DAYS)).timestamp()
    )

    for location in LOCATIONS:
        print(f"{location}")
        df, source_hash, source_files = fetch(client, DATASET, start, end, location=location)
        # Sort on the parsed timestamp, not the raw column: a mix of cached
        # chunks (ISO strings read back from JSON) and a freshly-fetched
        # chunk (already Timestamp-typed) can leave interval_start_utc as a
        # mixed-type object column that sort_values can't compare directly.
        df = df.dropna(subset=[PRICE_COLUMN])
        df = df.assign(_ts=pd.to_datetime(df["interval_start_utc"], utc=True)).sort_values("_ts")

        m15 = build_native_15m(df)
        m15_windowed = m15[m15["t"] >= window_start_t]
        h1 = resample_fixed(df, "1h")
        h4 = resample_fixed(df, "4h")
        d1 = resample_central_day(df)
        w1 = resample_weeks(d1)

        payload = {
            "location": location,
            "dataset": DATASET,
            "priceColumn": PRICE_COLUMN,
            "sourceHash": source_hash,
            "sourceFiles": source_files,
            "hashAlgorithm": "sha256",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "candles": {
                "15m": to_records(m15_windowed),
                "1h": to_records(h1),
                "4h": to_records(h4),
                "1d": to_records(d1.drop(columns=["day"])),
                "1w": to_records(w1),
            },
        }

        out_path = OUT_DIR / f"{location}.json"
        out_path.write_text(json.dumps(payload))
        counts = {tf: len(series) for tf, series in payload["candles"].items()}
        print(f"  wrote {out_path} -- {counts}")

    print(f"\nRow cost note: {DATASET} costs ~96 rows/day per location; check "
          "GridStatus's monthly row allowance before widening --days.")


if __name__ == "__main__":
    main()
