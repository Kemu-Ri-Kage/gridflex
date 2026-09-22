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

By default only ERCOT_HBNORTH_DA_AVG is fetched: the site shows only the
Texas power price and every live market settles on it. The other metrics
are feed-only and fetched on request (--feed-metrics, --fuel-mix).

Usage
-----
    python fetch_ercot.py                  # yesterday and today
    python fetch_ercot.py --days 30        # last 30 days and today
    python fetch_ercot.py --days 365       # last year (watch the row budget)
    python fetch_ercot.py --fill-gaps      # also every day missing since the
                                           # latest complete day in data/metrics
    python fetch_ercot.py --feed-metrics   # also basis, negative intervals and
                                           # the load-weighted index
    python fetch_ercot.py --fuel-mix       # also the fuel mix feed
    python fetch_ercot.py --plan           # dry run: print the requests a run
                                           # would make, without touching the API
    python fetch_ercot.py --usage          # print this month's GridStatus usage
                                           # against the plan's limits, then exit

Requests: one per dataset per run, spanning every day the cache can't
answer (see fetch). The default run is one request. A run refuses to start
a fetch that would push it past --max-requests (default 12) - the free plan
meters requests as well as rows, and a mistaken flag can burn a month's
allowance in one go.

Row budget: the GridStatus free plan allows 500,000 rows/month. With the
location filters below, one year costs roughly 8,800 (day-ahead) + 35,000
(real-time) + 105,000 (fuel mix) rows per location. Fuel mix is the
expensive one because it arrives every 5 minutes.
"""

import argparse
import hashlib
import json
import os
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING

import pandas as pd

if TYPE_CHECKING:
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
SUPERSEDED_DIR = RAW_DIR / "superseded"
METRICS_DIR = Path("data/metrics")
PUBLISH_LEDGER = Path("data/publish-ledger.json")

RATE_LIMIT_SLEEP = 1.5          # free plan allows 1 request/second

# Only today and the last RECENT_DAYS market days before it (UTC) are
# re-fetched on every run: GridStatus can still fill in or correct their
# intervals. Anything older is settled and read from the cache - including
# earlier days of the current month, which is why the current month is
# cached one day per chunk.
RECENT_DAYS = 3

# A dataset's uncached chunks are read in ONE request spanning all of them,
# then split into their chunk files. Only a backfill longer than this is
# broken up (at chunk boundaries): a year in one response trips a brotli
# decode bug in the HTTP stack (see month_chunks).
MAX_REQUEST_DAYS = 31

# Rows GridStatus returned to this process - what the free plan meters - and
# the requests that returned them. Cached chunks cost nothing and are not
# counted.
rows_fetched = 0
requests_made = 0

# HTTP requests the GridStatus client actually sent (counted on the real
# client only, see count_http_requests). Normally equal to requests_made; it
# is higher when a single get_dataset call had to page through a response,
# because the plan meters every page as a request.
http_requests = 0

# Upper bound on requests_made for this process. None means no limit; the
# command-line tools set it (--max-requests). Checked in fetch() before a
# dataset's requests are sent, so a run stops before spending, not after.
request_budget = None


# --------------------------------------------------------------------------
# FETCH
# --------------------------------------------------------------------------

def get_client() -> "GridStatusClient":
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
    # gridstatusio performs an unrelated PyPI version check at import time.
    # Keep ordinary imports/tests offline-safe and load the API client only
    # when the operator explicitly starts a real data fetch.
    os.environ.setdefault("GSIO_SKIP_VERSION_CHECK", "true")
    from gridstatusio import GridStatusClient

    client = GridStatusClient(api_key=key)

    # Belt and braces on top of month chunking: ask the server not to send
    # brotli-compressed responses at all. The decode bug we hit lives in the
    # brotli path, and gzip is plenty fast for this volume.
    try:
        client.session.headers["Accept-Encoding"] = "gzip, deflate"
    except AttributeError:
        pass          # client internals changed; chunking still protects us

    count_http_requests(client)
    return client


def count_http_requests(client):
    """
    Count every HTTP request the client sends, not just every get_dataset()
    call. get_dataset() pages through a response when it is bigger than the
    plan's rows-per-response limit, and each page is a metered request; a
    count taken at the call level would under-report exactly when it
    matters. Wraps client.get, the one method every request goes through.
    """
    original = getattr(client, "get", None)
    if original is None:
        return client

    def counted(*args, **kwargs):
        global http_requests
        http_requests += 1
        return original(*args, **kwargs)

    client.get = counted
    return client


def api_usage(client):
    """This month's usage against the plan's limits, from /v1/api_usage."""
    usage = client.get_api_usage()
    limits = usage.get("limits", {}) or {}
    period = usage.get("current_period_usage", {}) or {}
    return {
        "plan": usage.get("plan_name"),
        "requests_used": period.get("total_requests"),
        "requests_limit": limits.get("api_requests_limit"),
        "rows_used": period.get("total_api_rows_returned"),
        "rows_limit": limits.get("api_rows_returned_limit"),
        "rows_per_response_limit": limits.get("api_rows_per_response_limit"),
        "raw": usage,
    }


def print_usage(client):
    """Print the plan's usage. Nothing here contains the key."""
    summary = api_usage(client)

    def fmt(value):
        return f"{value:,}" if isinstance(value, (int, float)) else str(value)

    print(f"GridStatus plan: {summary['plan']}")
    print(f"  requests this period: {fmt(summary['requests_used'])}"
          f" of {fmt(summary['requests_limit'])}")
    print(f"  rows this period:     {fmt(summary['rows_used'])}"
          f" of {fmt(summary['rows_limit'])}")
    print(f"  rows per response:    {fmt(summary['rows_per_response_limit'])}")
    for key in ("current_period_start", "current_period_end", "period_start",
                "period_end", "reset_date", "resets_at"):
        if key in summary["raw"]:
            print(f"  {key}: {summary['raw'][key]}")
    print("  full response:")
    print("    " + json.dumps(summary["raw"], indent=2, default=str)
          .replace("\n", "\n    "))


def month_chunks(start, end):
    """
    Split a date range into calendar-month pieces.

    Three reasons this matters. A year of 15-minute prices in one response is
    large enough to trip a brotli decode bug in the HTTP stack (we hit it, it
    reproduces). Smaller responses stay well clear of it. A failure halfway
    through costs one month rather than the whole pull. And each chunk caches
    separately, so re-running only fetches what is missing or not yet final
    (see chunk_is_final). plan_chunks() splits these further into days
    where a month is still in progress.
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


def utc_today():
    return datetime.now(timezone.utc).date()


def is_dst_changeover(day):
    """
    True on the two Central days a year that are 23 or 25 hours long. They
    never have EXPECTED_ROWS hours, so their metric files are never written
    (see shared/metrics.md) - a missing file on one of them isn't a gap.
    """
    start = pd.Timestamp(day).tz_localize(CENTRAL)
    end = pd.Timestamp(day + timedelta(days=1)).tz_localize(CENTRAL)
    return end - start != pd.Timedelta(hours=24)


def latest_complete_day(metric_id=DAY_AHEAD["metric_id"], metrics_dir=None):
    """
    The last day of the unbroken run of metric files that starts at the
    earliest one: the day before the first missing day, or the newest file
    when nothing is missing. None with no files at all.

    Judged on the day-ahead settlement price, the metric every other daily
    contract metric is computed alongside. DST changeover days are skipped,
    never counted as missing.
    """
    metrics_dir = metrics_dir or METRICS_DIR
    prefix = f"{metric_id}__"
    days = set()
    for path in metrics_dir.glob(f"{prefix}*.json"):
        try:
            days.add(date.fromisoformat(path.stem[len(prefix):]))
        except ValueError:
            continue
    if not days:
        return None
    day, last = min(days), max(days)
    while day < last:
        following = day + timedelta(days=1)
        if following not in days and not is_dst_changeover(following):
            return day
        day = following
    return last


def fetch_window(days, fill_gaps=False, today=None, metrics_dir=None):
    """
    The [start, end) market days one run reads.

    The end is tomorrow, so today is included: ERCOT publishes a day's
    day-ahead prices on the afternoon before it (about 13:30 Central), which
    is before 00:00 UTC of that day, so on any UTC date that day's prices
    already exist. Real-time data for today is still partial and fails the
    completeness check, as it should.

    The start is `days` before today. With fill_gaps it moves back to the
    day after the latest complete day in data/metrics, so a day that was
    never fetched - one that aged out of the recent window before any run
    reached it - is filled. Which of these days are re-fetched rather than
    read from cache is still decided by chunk_is_final (RECENT_DAYS).
    """
    today = today or utc_today()
    start = today - timedelta(days=days)
    if fill_gaps:
        complete = latest_complete_day(metrics_dir=metrics_dir)
        if complete is not None:
            start = min(start, complete + timedelta(days=1))
    return start, today + timedelta(days=1)


def chunk_is_final(start, end, today=None):
    """
    True when a cached chunk [start, end) can be trusted without re-fetching:
    it ends before the last RECENT_DAYS days, so every day in it is settled.
    "Today" is the UTC date, the same clock main() uses to pick the fetch
    window.
    """
    today = today or utc_today()
    end_day = date.fromisoformat(str(end)[:10])
    return end_day <= today - timedelta(days=RECENT_DAYS)


def chunk_path(dataset, location, start, end):
    return RAW_DIR / f"{dataset}__{location or 'all'}__{start}__{end}.json"


def day_chunks(start, end):
    """[start, end) as one-day pieces."""
    first = date.fromisoformat(str(start)[:10])
    last = date.fromisoformat(str(end)[:10])
    return [(str(first + timedelta(days=i)), str(first + timedelta(days=i + 1)))
            for i in range((last - first).days)]


def plan_chunks(dataset, location, start, end, today=None):
    """
    The chunks to read for [start, end), chosen so settled data is never
    fetched twice.

    A month that is still in progress (any of it within the last RECENT_DAYS
    days) is read one day per chunk. Each day's filename never changes, so
    once a day has aged out of the recent window its cached file is final
    and stays - no re-read of the month so far, and no sliding "last N days"
    chunk that would need its oldest day fetched again under a new name.

    A settled month uses its whole-month file when that is cached. If it
    isn't but some of its days are (it was read day by day while it was in
    progress), the days are used and only missing days are fetched. With
    neither, it is one whole-month request, which keeps a first large pull
    to one request per month.
    """
    today = today or utc_today()
    out = []
    for piece_start, piece_end in month_chunks(start, end):
        if not chunk_is_final(piece_start, piece_end, today):
            out.extend(day_chunks(piece_start, piece_end))
            continue
        if chunk_path(dataset, location, piece_start, piece_end).exists():
            out.append((piece_start, piece_end))
            continue
        days = day_chunks(piece_start, piece_end)
        if any(chunk_path(dataset, location, s, e).exists() for s, e in days):
            out.extend(days)
        else:
            out.append((piece_start, piece_end))
    return out


def store_chunk(cache_path, payload):
    """
    Write fresh bytes for a chunk, keeping any different earlier version.

    Metric files cite chunk filenames in sourceFiles, and a reading already
    published onchain carries a hash of the bytes that were there then.
    Overwriting them would leave that hash unreproducible, so a changed chunk
    moves its old bytes to data/raw/superseded/ first. Identical bytes are
    left alone.
    """
    if cache_path.exists():
        old = cache_path.read_bytes()
        if old == payload.encode():
            return
        SUPERSEDED_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        archived = SUPERSEDED_DIR / f"{cache_path.stem}__{stamp}.json"
        cache_path.rename(archived)
        print(f"    changed upstream; previous bytes kept in {archived}")
    cache_path.write_text(payload)


def chunks_to_fetch(dataset, location, chunks, today=None):
    """The planned chunks the cache can't answer: missing, or not yet final."""
    return [(s, e) for s, e in chunks
            if not (chunk_path(dataset, location, s, e).exists()
                    and chunk_is_final(s, e, today))]


def request_spans(chunks):
    """
    Group chunks (in date order) into request spans: one span from the first
    to the last, unless that is longer than MAX_REQUEST_DAYS, in which case
    it breaks at chunk boundaries. Cached final chunks lying inside a span
    are re-read by the request but never rewritten (see fetch).
    """
    spans = []
    for start, end in chunks:
        if spans:
            span_start = date.fromisoformat(spans[-1][0])
            if (date.fromisoformat(end) - span_start).days <= MAX_REQUEST_DAYS:
                spans[-1] = (spans[-1][0], end)
                continue
        spans.append((start, end))
    return spans


def plan_requests(dataset, location, start, end, today=None):
    """
    The requests fetch() would send for [start, end): the spans covering the
    planned chunks the cache can't answer. No API call is made. Used by
    --plan and by the request budget check.
    """
    chunks = plan_chunks(dataset, location, start, end, today)
    return request_spans(chunks_to_fetch(dataset, location, chunks, today))


def check_request_budget(dataset, location, spans):
    """Stop before sending if these spans would exceed request_budget."""
    if request_budget is None or not spans:
        return
    if requests_made + len(spans) > request_budget:
        raise SystemExit(
            f"Refusing to fetch {dataset} ({location or 'all'}): this run has "
            f"made {requests_made} request(s) and needs {len(spans)} more, "
            f"over the budget of {request_budget}.\n"
            "Run with --plan to see what would be fetched, or raise "
            "--max-requests if that is really intended."
        )


def fetch_span(client, dataset, start, end, location=None):
    """One GridStatus request for [start, end). Counts rows and requests."""
    global rows_fetched, requests_made
    print(f"    fetching {start} -> {end} (one request) ...")
    # timezone=CENTRAL makes start/end mean Central-time midnights, so a "day"
    # of data is a real ERCOT market day rather than a UTC day that straddles
    # two of them.
    kwargs = dict(dataset=dataset, start=start, end=end,
                  limit=None, timezone=CENTRAL)
    if location:
        kwargs.update(filter_column="location", filter_value=location)

    df = client.get_dataset(**kwargs)
    time.sleep(RATE_LIMIT_SLEEP)
    rows_fetched += len(df)
    requests_made += 1
    return df


def split_into_chunks(df, chunks):
    """
    {chunk: rows of df whose Central market day falls in it}. A chunk's rows
    serialise to the same bytes a request for just that chunk returns
    (checked against the cache: a 20-day response split by day matched all
    18 separately fetched day files byte for byte), so a day file means the
    same thing however it was fetched.
    """
    if df.empty or "interval_start_utc" not in df.columns:
        return {chunk: df.iloc[0:0] for chunk in chunks}
    days = to_central_day(df)["market_day"].astype(str)
    return {(s, e): df[(days >= s) & (days < e)] for s, e in chunks}


def fetch(client, dataset, start, end, location=None, tag=""):
    """
    Pull one dataset for a date range and return it as a single DataFrame
    along with a source hash and the list of cache files.

    plan_chunks() decides which cache files cover the range. The ones the
    cache can't answer (missing, or inside the recent window) are read in a
    single request spanning all of them - one request per dataset per run,
    never one per day - and the response is split back into those chunk
    files, each written through store_chunk (changed bytes are kept in
    data/raw/superseded/). A chunk that is already cached and final is never
    rewritten, even when the request's span covers it. A final chunk the
    response had no rows for isn't written, so the next run asks again.

    Every chunk is then read back from its file, so the frame and the hash
    come from exactly the same bytes.

    The source hash covers the concatenated raw bytes of every chunk, in date
    order. Anyone can reproduce it:

        cat data/raw/<dataset>__<loc>__*.json | shasum -a 256

    Caching matters: you will run this many times while debugging, and every
    re-fetch spends rows from the free monthly allowance.
    """
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    chunks = plan_chunks(dataset, location, start, end)
    wanted = chunks_to_fetch(dataset, location, chunks)
    print(f"    {len(chunks) - len(wanted)} of {len(chunks)} chunk(s) from cache")
    spans = request_spans(wanted)
    check_request_budget(dataset, location, spans)
    for span_start, span_end in spans:
        in_span = [c for c in wanted if span_start <= c[0] and c[1] <= span_end]
        response = fetch_span(client, dataset, span_start, span_end, location)
        for (s, e), rows in split_into_chunks(response, in_span).items():
            if rows.empty and chunk_is_final(s, e):
                continue
            store_chunk(chunk_path(dataset, location, s, e),
                        rows.to_json(orient="records", date_format="iso"))

    frames, paths = [], []
    for chunk_start, chunk_end in chunks:
        path = chunk_path(dataset, location, chunk_start, chunk_end)
        if not path.exists():
            continue
        df = pd.read_json(path, orient="records")
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

def published_readings():
    """{"<metricId>:<dayKey>": ledger entry} for readings already submitted
    onchain, from publish.py's ledger. Empty when nothing is published."""
    if not PUBLISH_LEDGER.exists():
        return {}
    ledger = json.loads(PUBLISH_LEDGER.read_text(encoding="utf-8"))
    return {key: entry for key, entry in ledger.items()
            if isinstance(entry, dict) and entry.get("txHash")}


def write_metric(metric_id, day, value, source_hash, source_files,
                  start_utc, end_utc, extra=None, published=None):
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

    A reading already published onchain (`published`, from
    published_readings) is never rewritten. A later run over a different
    date range hashes a different set of chunks, so rewriting it would
    change its sourceHash and the feed would report a MISMATCH against the
    chain. If the recomputed value differs from the published one, that is
    printed as a warning, not written. Returns None when nothing was written.
    """
    path = METRICS_DIR / f"{metric_id}__{day}.json"
    entry = (published or {}).get(f"{metric_id}:{day_key(day)}")
    if entry is not None and path.exists():
        if int(entry.get("value", value)) != value:
            print(f"  WARNING {metric_id} {day}: recomputed {value}, published "
                  f"{entry['value']} - published file kept unchanged")
        return None
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
    path.write_text(json.dumps(record, indent=2))
    return path


# --------------------------------------------------------------------------
# MAIN
# --------------------------------------------------------------------------

def datasets_for_run(feed_metrics=False, fuel_mix=False):
    """(label, dataset, location) for everything a run with these flags reads."""
    out = [("Day-ahead prices, HB_NORTH", DAY_AHEAD["dataset"], DAY_AHEAD["location"])]
    if feed_metrics:
        out.append(("West-North basis", BASIS["dataset"], BASIS["location"]))
        out.append(("Negative intervals, HB_WEST", REAL_TIME["dataset"],
                    REAL_TIME["location"]))
        for point in INDEX["zones"]:
            out.append((f"Load-weighted index, {point}", INDEX["price_dataset"], point))
        out.append(("Load-weighted index, load", INDEX["load_dataset"], None))
    if fuel_mix:
        out.append(("Fuel mix", FUEL_MIX["dataset"], None))
    return out


def print_plan(start, end, feed_metrics=False, fuel_mix=False):
    """What a run would fetch, computed from the cache alone. No API calls."""
    total = 0
    for label, dataset, location in datasets_for_run(feed_metrics, fuel_mix):
        spans = plan_requests(dataset, location, start, end)
        total += len(spans)
        print(f"{label}: {len(spans)} request(s)")
        for span_start, span_end in spans:
            print(f"    {span_start} -> {span_end}")
    print(f"\nPLAN ONLY - no requests were made. This run would make {total} "
          f"GridStatus request(s)" + (f", over the budget of {request_budget}."
                                      if request_budget and total > request_budget
                                      else "."))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=1,
                        help="how many days before today to read, plus today "
                             "(default 1)")
    parser.add_argument("--fill-gaps", action="store_true",
                        help="also read every day missing since the latest "
                             "complete day in data/metrics")
    parser.add_argument("--feed-metrics", action="store_true",
                        help="also fetch the feed-only metrics the site no "
                             "longer shows: West Hub day-ahead (basis), West "
                             "Hub real-time (negative intervals) and the "
                             "load-weighted index (4 load zones + load)")
    parser.add_argument("--fuel-mix", action="store_true",
                        help="also fetch the fuel mix feed (about 288 rows/day)")
    parser.add_argument("--plan", action="store_true",
                        help="dry run: print the GridStatus requests this run "
                             "would make and exit without making any")
    parser.add_argument("--usage", action="store_true",
                        help="print this month's GridStatus usage against the "
                             "plan's limits and exit (one request)")
    parser.add_argument("--max-requests", type=int, default=12,
                        help="refuse to fetch past this many GridStatus "
                             "requests in one run (default 12; 0 = no limit)")
    args = parser.parse_args()

    global request_budget
    request_budget = args.max_requests or None

    if args.usage:
        print_usage(get_client())
        return

    start_date, end_date = fetch_window(args.days, fill_gaps=args.fill_gaps)
    start, end = str(start_date), str(end_date)
    recent_start = utc_today() - timedelta(days=args.days)

    print(f"GRIDFLEX pipeline: {start} to {end}")
    if start_date < recent_start:
        print(f"  filling missing days {start} to {recent_start - timedelta(days=1)}")
    print()

    if args.plan:
        print_plan(start, end, feed_metrics=args.feed_metrics,
                   fuel_mix=args.fuel_mix)
        return

    client = get_client()

    # Readings already onchain keep their committed file - see write_metric.
    published = published_readings()

    def write(*args, **kwargs):
        return write_metric(*args, published=published, **kwargs)

    # ---- day-ahead price ------------------------------------------------
    print("Day-ahead prices, HB_NORTH")
    df_da, hash_da, files_da = fetch(
        client, DAY_AHEAD["dataset"], start, end,
        location=DAY_AHEAD["location"])
    for day, result in day_ahead_average(df_da).items():
        write(DAY_AHEAD["metric_id"], day, result["value"],
                     hash_da, files_da, result["start_utc"], result["end_utc"],
                     {"hoursUsed": result["hours_used"]})
        print(f"  {day}  ${result['value'] / 100:8.2f}/MWh"
              f"   ({result['hours_used']} hours)")

    # ---- feed-only metrics (--feed-metrics) -------------------------------
    # The site shows only the Texas power price, and every live market
    # settles on it, so a refresh reads North Hub day-ahead prices alone.
    # These four stay computable on request; their files are still written
    # to web/public/data/ from whatever data/metrics holds.
    if args.feed_metrics:
        # ---- west-north basis spread -------------------------------------
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
            write(BASIS["metric_id"], day, result["value"],
                         basis_hash, basis_files,
                         result["start_utc"], result["end_utc"],
                         {"westAvg": round(result["west"], 2),
                          "northAvg": round(result["north"], 2)})
            print(f"  {day}  {result['value'] / 100:+8.2f}/MWh"
                  f"   (W {result['west']:6.2f}  N {result['north']:6.2f})")

        # ---- real-time negative intervals --------------------------------
        print("\nReal-time negative intervals, HB_WEST")
        df_rt, hash_rt, files_rt = fetch(
            client, REAL_TIME["dataset"], start, end,
            location=REAL_TIME["location"])
        for day, result in negative_intervals(df_rt).items():
            write(REAL_TIME["metric_id"], day, result["value"],
                         hash_rt, files_rt, result["start_utc"], result["end_utc"],
                         {"intervalsUsed": result["intervals_used"]})
            print(f"  {day}  {result['value']:3d} negative"
                  f"   (of {result['intervals_used']} intervals)")

        # ---- load-weighted statewide index -------------------------------
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
            write(INDEX["metric_id"], day, result["value"],
                         index_hash, files,
                         result["start_utc"], result["end_utc"],
                         {"hoursUsed": result["hours"],
                          "loadWeights": result["weights"]})
            w = result["weights"]
            print(f"  {day}  ${result['value'] / 100:8.2f}/MWh   "
                  + "  ".join(f"{z[:3].upper()} {s:.0%}" for z, s in sorted(w.items())))

    # ---- fuel mix (feed only) -------------------------------------------
    if args.fuel_mix:
        print("\nFuel mix")
        df_fm, hash_fm, files_fm = fetch(
            client, FUEL_MIX["dataset"], start, end)
        for day, result in fuel_shares(df_fm).items():
            shares = result["shares"]
            for fuel, share in shares.items():
                write(FUEL_MIX["metric_prefix"] + fuel, day, share,
                             hash_fm, files_fm,
                             result["start_utc"], result["end_utc"])
            top = sorted(shares.items(), key=lambda kv: -kv[1])[:3]
            summary = "  ".join(f"{f} {v / 100:.1f}%" for f, v in top)
            print(f"  {day}  {summary}")

    print(f"\nGridStatus requests this run: {requests_made}")
    if http_requests != requests_made:
        print(f"GridStatus HTTP requests sent (paged responses): {http_requests}")
    print(f"GridStatus rows fetched this run: {rows_fetched:,}")
    print(f"Wrote metric files to {METRICS_DIR}/")
    print(f"Raw responses cached in {RAW_DIR}/ (gitignore this folder)")


if __name__ == "__main__":
    main()
