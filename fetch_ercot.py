"""
GRIDFLEX — ERCOT data pipeline
==============================

Turns public ERCOT market data into the two numbers our contracts settle on,
plus the fuel-mix feed, and writes each one with a hash of the raw source so
anyone can verify it independently.

Metrics produced (one value per Central-time day):

  ERCOT_HBNORTH_DA_AVG          mean of 24 hourly day-ahead prices at HB_NORTH
                                stored as USD/MWh x 100 (integer)

  ERCOT_HBWEST_NEG_INTERVALS    count of 15-min real-time intervals at HB_WEST
                                where the price was below zero (0-96)

  ERCOT_FUELMIX_<FUEL>          share of generation by fuel, percent x 100
                                (feed display only — not a contract metric)

Usage
-----
    python fetch_ercot.py                  # yesterday only
    python fetch_ercot.py --days 30        # last 30 days
    python fetch_ercot.py --days 365       # last year (watch the row budget)

Row budget: the GridStatus free plan allows 500,000 rows/month. With the
location filters below, one year costs roughly 8,800 (day-ahead) + 35,000
(real-time) + 105,000 (fuel mix) rows. Fuel mix is the expensive one because
it arrives every 5 minutes, so --skip-fuelmix is available.
"""

import argparse
import hashlib
import json
import os
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
from gridstatusio import GridStatusClient

# --------------------------------------------------------------------------
# CONFIG — the whole spec lives here. Change a zone by changing these lines.
# --------------------------------------------------------------------------

CENTRAL = "US/Central"          # ERCOT market days are Central Prevailing Time

DAY_AHEAD = {
    "dataset": "ercot_spp_day_ahead_hourly",
    "location": "HB_NORTH",
    "price_column": "spp",
    "metric_id": "ERCOT_HBNORTH_DA_AVG",
}

REAL_TIME = {
    "dataset": "ercot_spp_real_time_15_min",
    "location": "HB_WEST",
    "price_column": "spp",
    "metric_id": "ERCOT_HBWEST_NEG_INTERVALS",
}

# Candidate replacement for the negative-interval metric. The day-ahead price
# at HB_WEST minus the day-ahead price at HB_NORTH is the west-to-north basis:
# it measures the same West Texas congestion that drives negative prices, but
# it moves every single day instead of sitting at zero all summer. Congestion
# rights are traded on exactly this spread in the real market.
BASIS = {
    "dataset": "ercot_spp_day_ahead_hourly",
    "location": "HB_WEST",
    "price_column": "spp",
    "metric_id": "ERCOT_WEST_NORTH_DA_BASIS",
}

FUEL_MIX = {
    "dataset": "ercot_fuel_mix",
    "metric_prefix": "ERCOT_FUELMIX_",
}

# ---- Load-weighted statewide index --------------------------------------
#
# What did Texas actually pay for electricity today?
#
# You cannot answer that by averaging the four zone prices equally: a zone
# that consumes 4 GW would count the same as one consuming 20 GW. The honest
# construction is total cost divided by total volume:
#
#     index = SUM over hours,zones ( price[h,z] * load[h,z] )
#             ---------------------------------------------
#             SUM over hours,zones ( load[h,z] )
#
# That weights by consumption in space AND time automatically — a 3pm hour
# with 70 GW flowing counts more than a 4am hour with 40 GW, which is correct,
# because more money changed hands. Weights are never hardcoded: they come
# from ERCOT's published hourly load, so they follow real shifts in demand
# (Houston's summer afternoon peak, West Texas's data-centre growth) without
# anyone maintaining a table.
#
# Prices come from LOAD ZONES (LZ_*), not trading hubs (HB_*). Load zones are
# where consumption is metered and where load actually settles, so they are
# the prices the weights belong to.

INDEX = {
    "price_dataset": "ercot_spp_day_ahead_hourly",
    "load_dataset": "ercot_load_by_forecast_zone",
    "price_column": "spp",
    "metric_id": "ERCOT_LOAD_WEIGHTED_DA_INDEX",
    # settlement point name -> the zone name used in the load data
    "zones": {
        "LZ_NORTH":   "north",
        "LZ_SOUTH":   "south",
        "LZ_WEST":    "west",
        "LZ_HOUSTON": "houston",
    },
}

# Rows expected in one complete market day. Partial days are skipped so a
# half-day never gets written as if it were a full one.
EXPECTED_ROWS = {
    "ercot_spp_day_ahead_hourly": 24,      # hourly
    "ercot_spp_real_time_15_min": 96,      # 15-minute
    "ercot_fuel_mix": 288,                 # 5-minute
    "ercot_load_by_forecast_zone": 24,     # hourly
}

# Contract metrics demand a complete day: a settlement number computed from a
# partial day is a wrong number, and someone gets paid on it. The fuel mix is
# display only and its values are ratios, so one missing 5-minute reading out
# of 288 is immaterial. Different jobs, different tolerances.
FUELMIX_MIN_COVERAGE = 0.95

RAW_DIR = Path("data/raw")
METRICS_DIR = Path("data/metrics")

RATE_LIMIT_SLEEP = 1.5          # free plan allows 1 request/second


# --------------------------------------------------------------------------
# FETCH
# --------------------------------------------------------------------------

def get_client() -> GridStatusClient:
    """Read the API key from the environment. Never hardcode it here."""
    key = os.environ.get("GRIDSTATUS_API_KEY")
    if not key:
        raise SystemExit(
            "GRIDSTATUS_API_KEY is not set.\n"
            "Create a file called .env next to this script containing:\n"
            "    GRIDSTATUS_API_KEY=your_key_here\n"
            "then run:  export $(cat .env | xargs)   (mac/linux)\n"
            "or set it in your shell on Windows."
        )
    client = GridStatusClient(api_key=key)

    # Belt and braces on top of month chunking: ask the server not to send
    # brotli-compressed responses at all. The decode bug we hit lives in the
    # brotli path, and gzip is plenty fast for this volume.
    try:
        client.session.headers["Accept-Encoding"] = "gzip, deflate"
    except AttributeError:
        pass          # client internals changed; chunking still protects us

    return client


def month_chunks(start, end):
    """
    Split a date range into calendar-month pieces.

    Three reasons this matters. A year of 15-minute prices in one response is
    large enough to trip a brotli decode bug in the HTTP stack (we hit it, it
    reproduces). Smaller responses stay well clear of it. A failure halfway
    through costs one month rather than the whole pull. And each chunk caches
    separately, so re-running only fetches what is missing.
    """
    s = pd.Timestamp(start)
    e = pd.Timestamp(end)
    out = []
    while s < e:
        nxt = min((s + pd.offsets.MonthBegin(1)).normalize(), e)
        if nxt <= s:                      # same month, go straight to the end
            nxt = e
        out.append((s.strftime("%Y-%m-%d"), nxt.strftime("%Y-%m-%d")))
        s = nxt
    return out


def fetch_chunk(client, dataset, start, end, location=None):
    """Fetch one chunk, cache the raw bytes, return (DataFrame, path)."""
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    slug = f"{dataset}__{location or 'all'}__{start}__{end}"
    cache_path = RAW_DIR / f"{slug}.json"

    if cache_path.exists():
        print(f"    cached   {start} -> {end}")
        return pd.read_json(cache_path.open(), orient="records"), cache_path

    print(f"    fetching {start} -> {end} ...")
    # timezone=CENTRAL makes start/end mean Central-time midnights, so a "day"
    # of data is a real ERCOT market day rather than a UTC day that straddles
    # two of them.
    kwargs = dict(dataset=dataset, start=start, end=end,
                  limit=None, timezone=CENTRAL)
    if location:
        kwargs.update(filter_column="location", filter_value=location)

    df = client.get_dataset(**kwargs)
    time.sleep(RATE_LIMIT_SLEEP)

    cache_path.write_text(df.to_json(orient="records", date_format="iso"))
    return df, cache_path


def fetch(client, dataset, start, end, location=None, tag=""):
    """
    Pull one dataset for a date range, month by month, and return it as a
    single DataFrame along with a source hash and the list of cache files.

    The source hash covers the concatenated raw bytes of every chunk, in date
    order. Anyone can reproduce it:

        cat data/raw/<dataset>__<loc>__*.json | shasum -a 256

    Caching matters: you will run this many times while debugging, and every
    re-fetch spends rows from the free monthly allowance.
    """
    frames, paths = [], []
    for chunk_start, chunk_end in month_chunks(start, end):
        df, path = fetch_chunk(client, dataset, chunk_start, chunk_end, location)
        if len(df):
            frames.append(df)
        paths.append(path)

    if not frames:
        raise SystemExit(f"No data returned for {dataset} between {start} and {end}.")

    combined = pd.concat(frames, ignore_index=True)

    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.read_bytes())

    # Return every filename, in hash order. A truncated label is useless for
    # verification: data/raw/ accumulates overlapping chunks from runs with
    # different --days values, so "glob everything for this dataset" gives the
    # wrong set. The exact ordered list is the only thing that reproduces.
    return combined, digest.hexdigest(), [p.name for p in paths]


# --------------------------------------------------------------------------
# COMPUTE
# --------------------------------------------------------------------------

def to_central_day(df):
    """Add a `market_day` column: the Central-time calendar day of each row."""
    ts = pd.to_datetime(df["interval_start_utc"], utc=True)
    df = df.copy()
    try:
        df["market_day"] = ts.dt.tz_convert(CENTRAL).dt.date
    except Exception as exc:
        raise SystemExit(
            f"Could not convert to {CENTRAL} timezone ({exc}).\n"
            "This usually means the timezone database is missing.\n"
            "Fix it with:  pip install tzdata"
        )
    return df


def day_key(day):
    """
    YYYYMMDD as a plain integer, e.g. 20260908.

    This is the identifier the oracle stores and markets look up — not an
    instant. It sorts chronologically, reads as a date at a glance, and
    Python and Solidity interpret it identically because it carries no
    timezone: there is nothing to convert, so there is nothing to get wrong.
    """
    return int(day.strftime("%Y%m%d"))


def day_bounds_from_df(df):
    """
    {market_day: (start_utc, end_utc)} — the true UTC instants bounding each
    Central market day, read directly off the rows GridStatus returned for
    that day rather than assumed as periodStart + 86400.

    start is the earliest interval_start_utc on the day, end is the latest
    interval_end_utc. On a normal day that span is 24 hours. On the
    spring-forward day it's 23 (Central time skips an hour), on the
    fall-back day it's 25 (Central time repeats one) — both come out
    correct automatically because they're read off real interval
    boundaries, not computed from a fixed offset.
    """
    df = to_central_day(df)
    out = {}
    for day, group in df.groupby("market_day"):
        start = pd.to_datetime(group["interval_start_utc"], utc=True).min()
        end = pd.to_datetime(group["interval_end_utc"], utc=True).max()
        out[day] = (int(start.timestamp()), int(end.timestamp()))
    return out


def day_ahead_average(df):
    """Mean day-ahead price per market day, as USD/MWh x 100 (integer)."""
    df = to_central_day(df)
    bounds = day_bounds_from_df(df)
    expected = EXPECTED_ROWS[DAY_AHEAD["dataset"]]
    out, skipped = {}, []
    for day, group in df.groupby("market_day"):
        if len(group) != expected:
            skipped.append((day, len(group)))
            continue
        mean_price = group[DAY_AHEAD["price_column"]].mean()
        start_utc, end_utc = bounds[day]
        out[day] = {
            "value": int(round(mean_price * 100)),
            "hours_used": int(len(group)),
            "start_utc": start_utc,
            "end_utc": end_utc,
        }
    for day, n in skipped:
        print(f"  {day}  SKIPPED - {n}/{expected} hours (incomplete day)")
    return out


def basis_spread(df_west, df_north):
    """
    Daily mean(HB_WEST day-ahead) - mean(HB_NORTH day-ahead), USD/MWh x 100.

    Negative basis means West Texas is cheaper than North: too much wind and
    solar for the lines out of the region. The more negative, the worse the
    congestion. Positive basis means the flow has reversed.
    """
    west = to_central_day(df_west)
    north = to_central_day(df_north)
    bounds = day_bounds_from_df(df_north)
    expected = EXPECTED_ROWS[BASIS["dataset"]]
    col = BASIS["price_column"]

    west_daily = {d: g[col].mean() for d, g in west.groupby("market_day")
                  if len(g) == expected}
    north_daily = {d: g[col].mean() for d, g in north.groupby("market_day")
                   if len(g) == expected}

    out = {}
    for day in sorted(set(west_daily) & set(north_daily)):
        start_utc, end_utc = bounds[day]
        out[day] = {
            "value": int(round((west_daily[day] - north_daily[day]) * 100)),
            "west": west_daily[day],
            "north": north_daily[day],
            "start_utc": start_utc,
            "end_utc": end_utc,
        }
    return out


def normalise_load(df, zones):
    """
    Return load as {(market_day, hour_utc): {zone: MW}}.

    GridStatus may hand this back wide (one column per zone) or long (a zone
    column plus a value column), so detect rather than assume — a silent shape
    change here would corrupt every weight.
    """
    df = to_central_day(df)
    ts = pd.to_datetime(df["interval_start_utc"], utc=True)

    lower = {c.lower(): c for c in df.columns}
    wide_cols = {z: lower[z] for z in zones.values() if z in lower}

    out = defaultdict(dict)

    if len(wide_cols) == len(zones):                       # wide format
        for i, key in enumerate(zip(df["market_day"], ts)):
            for zone, col in wide_cols.items():
                value = df[col].iloc[i]
                if pd.notna(value):
                    out[key][zone] = float(value)
        return out

    zone_col = next((lower[c] for c in ("zone", "location", "forecast_zone")
                     if c in lower), None)
    value_col = next((lower[c] for c in ("load", "value", "mw", "demand")
                      if c in lower), None)
    if not zone_col or not value_col:
        raise SystemExit(
            "Cannot read the load data: expected one column per zone, or a "
            f"zone column plus a value column. Got: {list(df.columns)}"
        )

    for i, key in enumerate(zip(df["market_day"], ts)):    # long format
        zone = str(df[zone_col].iloc[i]).strip().lower()
        if zone in set(zones.values()):
            out[key][zone] = float(df[value_col].iloc[i])
    return out


def load_weighted_index(price_frames, df_load):
    """
    Total cost / total volume, per market day.

    price_frames: {settlement_point: DataFrame}
    Returns {day: {"value": int (USD/MWh x100), "hours": int,
                   "weights": {zone: share}}}
    """
    zones = INDEX["zones"]
    col = INDEX["price_column"]
    expected = EXPECTED_ROWS[INDEX["price_dataset"]]

    load = normalise_load(df_load, zones)
    bounds = day_bounds_from_df(df_load)

    # price lookup: {(day, hour_utc): {zone: price}}
    prices = defaultdict(dict)
    for point, df in price_frames.items():
        zone = zones[point]
        df = to_central_day(df)
        ts = pd.to_datetime(df["interval_start_utc"], utc=True)
        for i, key in enumerate(zip(df["market_day"], ts)):
            prices[key][zone] = float(df[col].iloc[i])

    cost, volume, hours = defaultdict(float), defaultdict(float), defaultdict(int)
    zone_mwh = defaultdict(lambda: defaultdict(float))

    for key, zone_prices in prices.items():
        zone_load = load.get(key)
        if not zone_load:
            continue
        # Every zone must be present on both sides for this hour to count.
        # A missing zone would silently drop its consumption from the
        # denominator and bias the index toward whoever is left.
        if set(zone_prices) != set(zones.values()):
            continue
        if set(zone_load) != set(zones.values()):
            continue

        day = key[0]
        hours[day] += 1
        for zone, price in zone_prices.items():
            mwh = zone_load[zone]          # 1 hour of MW = MWh
            cost[day] += price * mwh
            volume[day] += mwh
            zone_mwh[day][zone] += mwh

    out, skipped = {}, []
    for day in sorted(cost):
        if hours[day] != expected:
            skipped.append((day, hours[day]))
            continue
        if volume[day] <= 0:
            continue
        total = volume[day]
        start_utc, end_utc = bounds[day]
        out[day] = {
            "value": int(round(cost[day] / total * 100)),
            "hours": hours[day],
            "weights": {z: round(mwh / total, 4)
                        for z, mwh in zone_mwh[day].items()},
            "start_utc": start_utc,
            "end_utc": end_utc,
        }
    for day, n in skipped:
        print(f"  {day}  SKIPPED - {n}/{expected} complete hours")
    return out


def negative_intervals(df):
    """Count 15-min intervals below zero per market day."""
    df = to_central_day(df)
    bounds = day_bounds_from_df(df)
    expected = EXPECTED_ROWS[REAL_TIME["dataset"]]
    out, skipped = {}, []
    for day, group in df.groupby("market_day"):
        prices = group[REAL_TIME["price_column"]]
        if len(prices) != expected:
            skipped.append((day, len(prices)))
            continue
        start_utc, end_utc = bounds[day]
        out[day] = {
            "value": int((prices < 0).sum()),
            "intervals_used": int(len(prices)),
            "start_utc": start_utc,
            "end_utc": end_utc,
        }
    for day, n in skipped:
        print(f"  {day}  SKIPPED - {n}/{expected} intervals (incomplete day)")
    return out


def fuel_shares(df):
    """Share of total generation by fuel per market day, as percent x 100."""
    df = to_central_day(df)
    bounds = day_bounds_from_df(df)
    fuels = [c for c in df.columns
             if c not in ("interval_start_utc", "interval_end_utc", "market_day")
             and pd.api.types.is_numeric_dtype(df[c])]
    expected = EXPECTED_ROWS[FUEL_MIX["dataset"]]
    minimum = int(expected * FUELMIX_MIN_COVERAGE)
    out = {}
    for day, group in df.groupby("market_day"):
        if len(group) < minimum:
            print(f"  {day}  SKIPPED - {len(group)}/{expected} readings")
            continue
        totals = group[fuels].sum()
        grand = totals.sum()
        if grand <= 0:
            continue
        start_utc, end_utc = bounds[day]
        out[day] = {
            "shares": {fuel.upper(): int(round(totals[fuel] / grand * 10000))
                       for fuel in fuels},
            "start_utc": start_utc,
            "end_utc": end_utc,
        }
    return out


# --------------------------------------------------------------------------
# WRITE
# --------------------------------------------------------------------------

def write_metric(metric_id, day, value, source_hash, source_files,
                  start_utc, end_utc, extra=None):
    """
    One JSON file per metric per day. This is exactly what publish.py will
    later hand to the oracle contract.

    dayKey (YYYYMMDD int) is the identifier the oracle stores and markets
    look up — it carries no timezone, so nothing about it can be
    misinterpreted by converting it. marketDayStartUtc/marketDayEndUtc are
    the true UTC instants bounding that Central market day, read off the
    actual data (see day_bounds_from_df) rather than assumed as a fixed
    86400-second span — a span that is wrong on both DST transition days.

    There is deliberately no periodStart/periodEnd field, aliased or
    otherwise. A field that looks like an instant but is actually a day
    identifier is exactly the trap dayKey replaces; keeping the old names
    around "for compatibility" would just give it a second way back in.
    """
    METRICS_DIR.mkdir(parents=True, exist_ok=True)
    record = {
        "metricId": metric_id,
        "dayKey": day_key(day),
        "marketDay": str(day),
        "marketDayStartUtc": start_utc,
        "marketDayEndUtc": end_utc,
        "value": value,
        "sourceHash": source_hash,
        "sourceFiles": source_files,   # exact files, in hash order
        "hashAlgorithm": "sha256",
        "computedAt": datetime.now(timezone.utc).isoformat(),
    }
    if extra:
        record.update(extra)
    path = METRICS_DIR / f"{metric_id}__{day}.json"
    path.write_text(json.dumps(record, indent=2))
    return path


# --------------------------------------------------------------------------
# MAIN
# --------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=1,
                        help="how many days back from yesterday (default 1)")
    parser.add_argument("--skip-fuelmix", action="store_true",
                        help="skip the fuel mix feed to save row budget")
    parser.add_argument("--skip-index", action="store_true",
                        help="skip the load-weighted statewide index "
                             "(5 extra queries per month chunk)")
    args = parser.parse_args()

    end_date = datetime.now(timezone.utc).date()
    start_date = end_date - timedelta(days=args.days)
    start, end = str(start_date), str(end_date)

    print(f"GRIDFLEX pipeline: {start} to {end}\n")
    client = get_client()

    # ---- day-ahead price ------------------------------------------------
    print("Day-ahead prices, HB_NORTH")
    df_da, hash_da, files_da = fetch(
        client, DAY_AHEAD["dataset"], start, end,
        location=DAY_AHEAD["location"])
    for day, result in day_ahead_average(df_da).items():
        write_metric(DAY_AHEAD["metric_id"], day, result["value"],
                     hash_da, files_da, result["start_utc"], result["end_utc"],
                     {"hoursUsed": result["hours_used"]})
        print(f"  {day}  ${result['value'] / 100:8.2f}/MWh"
              f"   ({result['hours_used']} hours)")

    # ---- west-north basis spread ------------------------------------------
    print("\nWest-North day-ahead basis")
    df_west, hash_w, files_w = fetch(
        client, BASIS["dataset"], start, end, location=BASIS["location"])

    # The basis is West MINUS North, so its source hash has to cover both
    # legs. Hashing only West would let someone verify half the inputs to a
    # number and believe they had verified all of it — worse than publishing
    # no hash at all. Same combining rule as the index: hash the leg hashes
    # in a fixed order.
    basis_hash = hashlib.sha256((hash_w + hash_da).encode()).hexdigest()
    basis_files = files_w + files_da

    for day, result in basis_spread(df_west, df_da).items():
        write_metric(BASIS["metric_id"], day, result["value"],
                     basis_hash, basis_files,
                     result["start_utc"], result["end_utc"],
                     {"westAvg": round(result["west"], 2),
                      "northAvg": round(result["north"], 2)})
        print(f"  {day}  {result['value'] / 100:+8.2f}/MWh"
              f"   (W {result['west']:6.2f}  N {result['north']:6.2f})")

    # ---- real-time negative intervals -----------------------------------
    print("\nReal-time negative intervals, HB_WEST")
    df_rt, hash_rt, files_rt = fetch(
        client, REAL_TIME["dataset"], start, end,
        location=REAL_TIME["location"])
    for day, result in negative_intervals(df_rt).items():
        write_metric(REAL_TIME["metric_id"], day, result["value"],
                     hash_rt, files_rt, result["start_utc"], result["end_utc"],
                     {"intervalsUsed": result["intervals_used"]})
        print(f"  {day}  {result['value']:3d} negative"
              f"   (of {result['intervals_used']} intervals)")

    # ---- load-weighted statewide index -----------------------------------
    if not args.skip_index:
        print("\nLoad-weighted ERCOT index (4 load zones, hourly weights)")
        price_frames, hashes, files = {}, [], []
        for point in INDEX["zones"]:
            df_z, h_z, f_z = fetch(
                client, INDEX["price_dataset"], start, end, location=point)
            price_frames[point] = df_z
            hashes.append(h_z)
            files.extend(f_z)

        df_load, h_load, f_load = fetch(
            client, INDEX["load_dataset"], start, end)
        hashes.append(h_load)
        files.extend(f_load)

        # One hash covering every input the index depends on, in a fixed
        # order, so the whole calculation is reproducible from the raw cache.
        index_hash = hashlib.sha256("".join(hashes).encode()).hexdigest()

        for day, result in load_weighted_index(price_frames, df_load).items():
            write_metric(INDEX["metric_id"], day, result["value"],
                         index_hash, files,
                         result["start_utc"], result["end_utc"],
                         {"hoursUsed": result["hours"],
                          "loadWeights": result["weights"]})
            w = result["weights"]
            print(f"  {day}  ${result['value'] / 100:8.2f}/MWh   "
                  + "  ".join(f"{z[:3].upper()} {s:.0%}" for z, s in sorted(w.items())))

    # ---- fuel mix (feed only) -------------------------------------------
    if not args.skip_fuelmix:
        print("\nFuel mix")
        df_fm, hash_fm, files_fm = fetch(
            client, FUEL_MIX["dataset"], start, end)
        for day, result in fuel_shares(df_fm).items():
            shares = result["shares"]
            for fuel, share in shares.items():
                write_metric(FUEL_MIX["metric_prefix"] + fuel, day, share,
                             hash_fm, files_fm,
                             result["start_utc"], result["end_utc"])
            top = sorted(shares.items(), key=lambda kv: -kv[1])[:3]
            summary = "  ".join(f"{f} {v / 100:.1f}%" for f, v in top)
            print(f"  {day}  {summary}")

    print(f"\nWrote metric files to {METRICS_DIR}/")
    print(f"Raw responses cached in {RAW_DIR}/ (gitignore this folder)")


if __name__ == "__main__":
    main()
