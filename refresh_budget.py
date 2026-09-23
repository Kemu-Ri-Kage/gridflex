"""
GRIDFLEX -- will one refresh fit in the GridStatus allowance?
=============================================================

refresh_data.sh runs this before it fetches anything. It works out, from the
raw cache alone, the requests and rows one refresh will spend - the same
chunk plan fetch_ercot.fetch() follows - then makes ONE call to
GridStatus's get_api_usage() and refuses (exit 1) unless both fit in what
is left of this period's allowance.

A refresh reads three datasets, one request per dataset (see refresh_data.sh):

  ercot_spp_day_ahead_hourly      HB_NORTH  the Texas power price    fetch_ercot.py
  ercot_spp_real_time_15_min      HB_NORTH  4H, 1D, 1W candles       build_candles.py
  ercot_lmp_by_settlement_point   HB_NORTH  15m, 1H candles          build_candles.py

Rows are budgeted at a DST-safe ceiling per market day (ROWS_PER_DAY), so the
estimate never undershoots: a 25-hour fall-back day has 25 hourly prices.

The allowance check fails closed. If get_api_usage() errors, or its answer
doesn't carry a monthly request and row limit and the usage against them,
the refresh is refused - a guard that can't read the allowance mustn't wave
a fetch through.

Usage:
    python refresh_budget.py            # plan, check the allowance, exit 0/1
    python refresh_budget.py --plan     # plan only; no GridStatus call at all
    python refresh_budget.py --tomorrow # the day-ahead window includes tomorrow,
                                        # as fetch_ercot.py --tomorrow reads it

The guard must never estimate a smaller fetch than the one that follows it,
so every flag that widens fetch_ercot.py's window has a twin here and
refresh_data.sh passes both.
"""

import argparse
import sys
import time
from datetime import date

import build_candles
import fetch_ercot

# Rows per market day are the ceilings fetch_ercot.ROWS_PER_DAY budgets with.
ROWS_PER_DAY = fetch_ercot.ROWS_PER_DAY

# The same days refresh_data.sh passes as --days.
REFRESH_DAYS = 3

# Where get_api_usage() keeps each figure. Its shape isn't pinned down in the
# client's docs, so each is looked up under the names it has been seen with;
# none found means refuse, not guess.
LIMIT_SECTIONS = ("limits", "plan_limits")
USAGE_SECTIONS = ("current_period_usage", "usage")
REQUEST_LIMIT_KEYS = ("api_requests_limit", "requests_limit", "monthly_requests_limit")
ROW_LIMIT_KEYS = ("api_rows_returned_limit", "rows_returned_limit", "api_rows_limit")
REQUESTS_USED_KEYS = ("total_requests", "requests", "api_requests")
ROWS_USED_KEYS = ("total_api_rows_returned", "api_rows_returned", "rows_returned",
                  "total_rows_returned")
PAGE_LIMIT_KEYS = ("api_rows_per_response_limit", "rows_per_response_limit")


def refresh_windows(today: date, include_tomorrow: bool = False) -> list:
    """[(dataset, location, start, end)] one refresh reads."""
    da_start, da_end = fetch_ercot.fetch_window(
        REFRESH_DAYS, fill_gaps=True, today=today, include_tomorrow=include_tomorrow)
    candles = build_candles.fetch_windows(today)
    location = fetch_ercot.DAY_AHEAD["location"]
    return [
        (fetch_ercot.DAY_AHEAD["dataset"], location, str(da_start), str(da_end)),
        (build_candles.DATASET, location, *candles[build_candles.DATASET]),
        (build_candles.FIVE_MIN_DATASET, location, *candles[build_candles.FIVE_MIN_DATASET]),
    ]


def plan_refresh(today: date, rows_per_page: int | None = None,
                 include_tomorrow: bool = False) -> list:
    """
    [{dataset, location, spans, requests, rows}] - what fetch() will request
    for each dataset, from the cache as it is now. A span longer than one
    response page costs one request per page. include_tomorrow widens the
    day-ahead window by one day, as fetch_ercot.py --tomorrow does.
    """
    return fetch_ercot.plan_reads(refresh_windows(today, include_tomorrow), today, rows_per_page)


def _find(section: dict, keys: tuple):
    for key in keys:
        if isinstance(section.get(key), (int, float)):
            return int(section[key])
    return None


def _section(usage: dict, names: tuple) -> dict:
    for name in names:
        if isinstance(usage.get(name), dict):
            return usage[name]
    return {}


def read_allowance(usage: dict) -> dict:
    """
    {requests_limit, requests_used, rows_limit, rows_used, rows_per_page}
    from a get_api_usage() answer. A limit of -1 means none (the client's
    docs) and comes back as None. Raises ValueError naming what's missing.
    """
    limits = _section(usage, LIMIT_SECTIONS)
    used = _section(usage, USAGE_SECTIONS)
    found = {
        "requests_limit": _find(limits, REQUEST_LIMIT_KEYS),
        "rows_limit": _find(limits, ROW_LIMIT_KEYS),
        "requests_used": _find(used, REQUESTS_USED_KEYS),
        "rows_used": _find(used, ROWS_USED_KEYS),
    }
    missing = [name for name, value in found.items() if value is None]
    if missing:
        raise ValueError(
            f"get_api_usage() answer has no {', '.join(missing)} "
            f"(top-level keys: {sorted(usage)}; limits: {sorted(limits)}; "
            f"usage: {sorted(used)})")
    for name in ("requests_limit", "rows_limit"):
        if found[name] < 0:
            found[name] = None
    page = _find(limits, PAGE_LIMIT_KEYS)
    found["rows_per_page"] = page if page and page > 0 else None
    return found


def check(plan: list, allowance: dict) -> list:
    """Reasons the refresh doesn't fit; empty when it does."""
    requests = sum(item["requests"] for item in plan)
    rows = sum(item["rows"] for item in plan)
    problems = []
    for what, need, limit, used in (
        ("requests", requests, allowance["requests_limit"], allowance["requests_used"]),
        ("rows", rows, allowance["rows_limit"], allowance["rows_used"]),
    ):
        if limit is None:
            continue
        left = limit - used
        if need > left:
            problems.append(f"needs {need:,} {what}, {max(left, 0):,} left "
                            f"({used:,} of {limit:,} used)")
    return problems


def print_plan(plan: list) -> None:
    for item in plan:
        spans = ", ".join(f"{s} -> {e}" for s, e in item["spans"]) or "all from cache"
        print(f"  {item['dataset']} {item['location']}: {item['requests']} request(s), "
              f"~{item['rows']:,} rows  [{spans}]")
    print(f"  one refresh: {sum(i['requests'] for i in plan)} request(s), "
          f"~{sum(i['rows'] for i in plan):,} rows")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", action="store_true",
                        help="print the plan only; make no GridStatus call")
    parser.add_argument("--tomorrow", action="store_true",
                        help="plan for fetch_ercot.py --tomorrow: the day-ahead "
                             "window includes tomorrow's market day")
    args = parser.parse_args(argv)
    today = fetch_ercot.utc_today()

    print(f"Planned GridStatus use of one refresh ({today}, from the raw cache"
          f"{', including tomorrow' if args.tomorrow else ''}):")
    plan = plan_refresh(today, include_tomorrow=args.tomorrow)
    print_plan(plan)
    if args.plan:
        return 0

    # One request, never retried: a retry would spend the allowance this
    # call is here to protect.
    client = fetch_ercot.get_client()
    client.max_retries = 0
    try:
        usage = client.get_api_usage()
    except Exception as exc:
        print(f"Refusing to refresh: get_api_usage() failed ({exc}).", file=sys.stderr)
        return 1
    finally:
        time.sleep(fetch_ercot.RATE_LIMIT_SLEEP)
    try:
        allowance = read_allowance(usage)
    except ValueError as exc:
        print(f"Refusing to refresh: {exc}.", file=sys.stderr)
        return 1

    if allowance["rows_per_page"]:
        plan = plan_refresh(today, allowance["rows_per_page"], include_tomorrow=args.tomorrow)

    def show(limit, used):
        return "no limit" if limit is None else f"{limit - used:,} of {limit:,} left"
    print(f"GridStatus allowance: requests {show(allowance['requests_limit'], allowance['requests_used'])}, "
          f"rows {show(allowance['rows_limit'], allowance['rows_used'])}")

    problems = check(plan, allowance)
    if problems:
        print("Refusing to refresh: it would not fit in the remaining allowance - "
              + "; ".join(problems) + ".", file=sys.stderr)
        return 1
    print("Fits in the remaining allowance.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
