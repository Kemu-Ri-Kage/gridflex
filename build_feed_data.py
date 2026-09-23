#!/usr/bin/env python3
"""Aggregate committed metric files + the publish ledger for the feed page.

Implements shared/feed-spec.md §9: the feed page never reads the 2,168 raw
data/metrics/*.json files directly, and never depends on a live RPC call to
render anything but its per-row verification badge. This script writes one
small, trimmed file per in-scope metric into web/public/data/, and the
landing page's price summary into web/lib/generated/ (imported at build
time, so it can't live in public/) - the only two paths under web/ this
script touches.

Reuses publish.py's metric-file loading and ledger I/O (shared/publish-spec.md
already validates and normalizes both) rather than re-parsing data/metrics/
files independently - a second, slightly-different parser is exactly the kind
of interface drift that `shared/oracle-interface.md` is designed to prevent.

Run by hand after a publish.py/finalize.py run, same hand-off shape
data/publish-ledger.json already uses - not part of the web/ build.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import pandas as pd

from fetch_ercot import CENTRAL, DAY_AHEAD, EXPECTED_ROWS, to_central_day
from publish import EXPECTED_METRICS, MetricReading, collect_readings, load_ledger

ROOT = Path(__file__).resolve().parent
WEB_DATA_DIR = ROOT / "web" / "public" / "data"
# Files the web app imports at build time rather than fetching by URL: they
# live outside public/, which Vite won't let JavaScript import from.
WEB_GENERATED_DIR = ROOT / "web" / "lib" / "generated"
ADDRESSES_SOURCE = ROOT / "shared" / "addresses.json"
METRICS_DIR = ROOT / "data" / "metrics"
RAW_DIR = ROOT / "data" / "raw"

# The one price the public site shows (design-brief.md §5: "Texas power
# price"), and the percentiles that bound its normal range.
PRICE_METRIC_ID = "ERCOT_HBNORTH_DA_AVG"
NORMAL_RANGE = (0.10, 0.90)

# The landing page's data-path diagram walks through one real, already-
# settled day end to end (see shared/demo-markets.md, market #1) rather
# than a synthetic example.
EVIDENCE_METRIC_ID = "ERCOT_HBNORTH_DA_AVG"
EVIDENCE_DAY = "2026-09-08"


def market_day_from_day_key(day_key: int) -> str:
    """YYYYMMDD -> "YYYY-MM-DD" by string slicing, never timezone conversion.

    dayKey is an opaque identifier, not a timestamp (oracle-interface.md);
    the ISO-date label it can safely produce is exactly the digit-slice
    that document already sanctions - "parsing it back into a date is
    string slicing, not timezone arithmetic."
    """
    text = str(day_key)
    return f"{text[0:4]}-{text[4:6]}-{text[6:8]}"


def aggregate(
    readings: list[MetricReading], ledger: dict[str, dict[str, Any]]
) -> dict[str, list[dict[str, Any]]]:
    """Group readings by metricId, trimmed to feed-page fields, sorted by dayKey.

    txHash is joined from the ledger's own record of what was actually
    submitted - null where no ledger entry exists for that metric-day, which
    is the common case before the real backfill runs (shared/feed-spec.md §9).
    Every in-scope metric gets an entry, even an empty one, so the page always
    has a file to fetch rather than a 404 for a metric with zero local data.
    """
    by_metric: dict[str, list[dict[str, Any]]] = {name: [] for name in EXPECTED_METRICS}
    for reading in readings:
        entry = ledger.get(reading.ledger_key)
        tx_hash = entry.get("txHash") if isinstance(entry, dict) else None
        by_metric.setdefault(reading.metric_id, []).append(
            {
                "dayKey": reading.day_key,
                "marketDay": market_day_from_day_key(reading.day_key),
                "value": reading.value,
                "sourceHash": reading.source_hash,
                "txHash": tx_hash,
            }
        )
    for records in by_metric.values():
        records.sort(key=lambda record: record["dayKey"])
    return by_metric


def write_aggregates(output_dir: Path, by_metric: dict[str, list[dict[str, Any]]]) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for metric_id, records in by_metric.items():
        path = output_dir / f"{metric_id}.json"
        path.write_text(json.dumps(records, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_addresses(output_dir: Path) -> None:
    """Publish the subset of shared/addresses.json the landing page shows.

    shared/addresses.json is the one source of truth for deployed addresses;
    the web app can't import a file outside web/ directly,
    so this writes a small derived copy into web/public/data/ the same way
    every other feed file here is derived from something outside web/ -
    never a second, hand-typed copy of the address.
    """
    if not ADDRESSES_SOURCE.exists():
        return
    source = json.loads(ADDRESSES_SOURCE.read_text(encoding="utf-8"))
    public = {
        "chainId": source.get("chainId"),
        "GridOracle": source.get("GridOracle"),
        "MarketFactory": source.get("MarketFactory"),
        "MockUSDT": source.get("MockUSDT"),
        "GridOracleDeployTx": source.get("transactions", {}).get("GridOracle"),
        # Only what the browser can't get from the chain itself: which
        # BinaryMarkets exist and where their history starts. Strike, day,
        # metric and state are read from each contract live, never from here.
        "markets": [
            {"market": entry["market"], "createTxHash": entry["createTxHash"]}
            for entry in source.get("markets", [])
        ],
    }
    path = output_dir / "addresses.json"
    path.write_text(json.dumps(public, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def latest_computed_at(metric_id: str, metrics_dir: Path | None = None) -> str | None:
    """The newest computedAt among one metric's files: when fetch_ercot.py
    last computed that price from fresh GridStatus data. None if no file
    carries one."""
    metrics_dir = metrics_dir or METRICS_DIR
    stamps = []
    for path in metrics_dir.glob(f"{metric_id}__*.json"):
        stamp = json.loads(path.read_text(encoding="utf-8")).get("computedAt")
        if stamp:
            stamps.append(pd.Timestamp(stamp))
    if not stamps:
        return None
    return max(stamps).tz_convert("UTC").isoformat().replace("+00:00", "Z")


def write_feed_meta(output_dir: Path) -> None:
    """Publish when the Texas power price data was last refreshed, for the
    feed's "Updated" line. A separate file so the per-metric aggregates keep
    their plain-array shape."""
    meta = {"metricId": PRICE_METRIC_ID, "updatedAt": latest_computed_at(PRICE_METRIC_ID)}
    path = output_dir / "feed-meta.json"
    path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_evidence(output_dir: Path) -> None:
    """Publish the raw metric file's dataset provenance for the landing
    page's diagram: real dataset name, location, and the exact sourceFiles
    list (not sourceHash alone) for one real, already-settled day.

    sourceFiles isn't part of the on-chain Reading struct (see
    shared/oracle-interface.md), so it doesn't reach web/public/data/ through
    write_aggregates() above - this publishes it separately, straight from
    the metric file data/metrics/ writes, rather than hand-typing a filename
    into a component where it could drift from the real sourceFiles list.
    """
    source = METRICS_DIR / f"{EVIDENCE_METRIC_ID}__{EVIDENCE_DAY}.json"
    if not source.exists():
        return
    record = json.loads(source.read_text(encoding="utf-8"))
    evidence = {
        "metricId": record["metricId"],
        "dayKey": record["dayKey"],
        "marketDay": record["marketDay"],
        "marketDayStartUtc": record["marketDayStartUtc"],
        "marketDayEndUtc": record["marketDayEndUtc"],
        "value": record["value"],
        "sourceHash": record["sourceHash"],
        "sourceFiles": record["sourceFiles"],
        "hashAlgorithm": record["hashAlgorithm"],
    }
    path = output_dir / "evidence-demo-day.json"
    path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def market_day_hours(hourly: pd.DataFrame, market_day: str, expected_value: int) -> pd.DataFrame:
    """The hourly rows of one market day, in hour order, held to the same bar
    as the daily price they come from.

    Exactly EXPECTED_ROWS hours on the Central market day (grouped by
    fetch_ercot's own to_central_day, so the day boundary can't drift from
    the metric's), and those hours must average to the published value -
    if they don't, these aren't the rows that produced it. Either failure
    raises rather than returning the wrong hours.
    """
    df = to_central_day(hourly)
    day = df[df["market_day"].astype(str) == market_day]
    expected_rows = EXPECTED_ROWS[DAY_AHEAD["dataset"]]
    if len(day) != expected_rows:
        raise ValueError(f"{market_day}: {len(day)}/{expected_rows} hours (incomplete day)")
    if int(round(day[DAY_AHEAD["price_column"]].mean() * 100)) != expected_value:
        raise ValueError(f"{market_day}: hourly mean does not match the published value {expected_value}")
    order = pd.to_datetime(day["interval_start_utc"], utc=True).sort_values().index
    return day.loc[order]


def hourly_swing(hourly: pd.DataFrame, market_day: str, expected_value: int) -> dict[str, Any]:
    """Cheapest and dearest hour of one market day, from its hourly prices
    (see market_day_hours for the rows it accepts)."""
    day = market_day_hours(hourly, market_day, expected_value)
    prices = day[DAY_AHEAD["price_column"]]

    def hour(label: Any) -> dict[str, Any]:
        start = pd.to_datetime(day.loc[label, "interval_start_utc"], utc=True)
        return {
            "hourStartCentral": start.tz_convert(CENTRAL).strftime("%H:%M"),
            "hourStartUtc": int(start.timestamp()),
            "value": int(round(prices.loc[label] * 100)),
        }

    return {"cheapest": hour(prices.idxmin()), "dearest": hour(prices.idxmax())}


def daily_candle(hourly: pd.DataFrame, market_day: str, expected_value: int) -> dict[str, int]:
    """One day's candle from its 24 hourly day-ahead prices, in cents: open
    at hour 0 (Central), close at hour 23, high and low across the day.
    Refused, like hourly_swing, unless the day is complete and its hours
    average to the published value."""
    prices = market_day_hours(hourly, market_day, expected_value)[DAY_AHEAD["price_column"]]
    cents = [int(round(price * 100)) for price in prices]
    return {"open": cents[0], "high": max(cents), "low": min(cents), "close": cents[-1]}


def hours_per_day(hourly: pd.DataFrame) -> dict[str, int]:
    """Distinct hourly intervals per Central market day, across every cached
    chunk (chunks overlap, so each interval is counted once)."""
    df = to_central_day(hourly.drop_duplicates(subset="interval_start_utc"))
    return {str(day): int(count) for day, count in df.groupby("market_day").size().items()}


def write_price_candles(output_dir: Path, records: list[dict[str, Any]]) -> dict[str, int]:
    """Publish one candle per published day for /trade's settlement-price
    chart, next to the daily price markets settle on.

    Each candle is built from the exact sourceFiles of that day's own metric
    file, read from the data/raw/ cache - the bytes its sourceHash covers,
    never a fresh fetch. A day that can't be reproduced from them, and any
    day between the first and last published day with no published price
    (the DST changeover days, which never have 24 hours), is listed under
    `skipped` with the hours the cache holds for it - never drawn from the
    hours present.
    """
    frames: dict[str, pd.DataFrame] = {}

    def raw(name: str) -> pd.DataFrame:
        if name not in frames:
            frames[name] = pd.read_json(RAW_DIR / name, orient="records")
        return frames[name]

    candles, skipped = [], []
    for record in records:
        try:
            metric_path = METRICS_DIR / f"{PRICE_METRIC_ID}__{record['marketDay']}.json"
            metric = json.loads(metric_path.read_text(encoding="utf-8"))
            hourly = pd.concat([raw(name) for name in metric["sourceFiles"]], ignore_index=True)
            candle = daily_candle(hourly, record["marketDay"], record["value"])
        except (OSError, KeyError, ValueError) as exc:
            print(f"SKIPPED candle: {exc}", file=sys.stderr)
            skipped.append({"dayKey": record["dayKey"], "reason": str(exc)})
            continue
        candles.append({"dayKey": record["dayKey"], "average": record["value"], **candle})

    if records:
        published = {record["marketDay"] for record in records}
        cached = sorted(RAW_DIR.glob(f"{DAY_AHEAD['dataset']}__{DAY_AHEAD['location']}__*.json"))
        hours = hours_per_day(pd.concat([raw(path.name) for path in cached], ignore_index=True)) if cached else {}
        expected_rows = EXPECTED_ROWS[DAY_AHEAD["dataset"]]
        for day in pd.date_range(records[0]["marketDay"], records[-1]["marketDay"], freq="D"):
            market_day = day.strftime("%Y-%m-%d")
            if market_day not in published:
                reason = f"{market_day}: {hours.get(market_day, 0)}/{expected_rows} hours (no published price)"
                print(f"SKIPPED candle: {reason}", file=sys.stderr)
                skipped.append({"dayKey": int(day.strftime("%Y%m%d")), "reason": reason})
    skipped.sort(key=lambda entry: entry["dayKey"])

    output = {"metricId": PRICE_METRIC_ID, "candles": candles, "skipped": skipped}
    path = output_dir / "price-candles.json"
    path.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {"candles": len(candles), "skipped": len(skipped)}


def price_range(records: list[dict[str, Any]]) -> dict[str, Any]:
    """The normal range of daily prices and the peak day, for the landing page.

    Normal is the middle 80% of published days (10th to 90th percentile), so
    a single spike can't stretch it; the peak is stated against the median
    day. All values stay in the metric's own cents scale.
    """
    values = pd.Series([record["value"] for record in records], dtype="float64")
    median = float(values.median())
    peak = max(records, key=lambda record: record["value"])
    return {
        "days": len(records),
        "firstDayKey": records[0]["dayKey"],
        "lastDayKey": records[-1]["dayKey"],
        "low": int(round(values.quantile(NORMAL_RANGE[0]))),
        "high": int(round(values.quantile(NORMAL_RANGE[1]))),
        "median": int(round(median)),
        "peak": {
            "dayKey": peak["dayKey"],
            "value": peak["value"],
            "timesMedian": round(peak["value"] / median),
        },
    }


def write_price_summary(output_dir: Path, records: list[dict[str, Any]]) -> bool:
    """Publish the landing page's lead: the latest day's cheapest and dearest
    hour, next to the normal range and the peak.
    Written to web/lib/generated/ (not public/): the web app imports it at
    build time and nothing fetches it by URL.

    The hours come from the exact sourceFiles list of the latest daily
    price's own metric file, read from the data/raw/ cache - the same bytes
    its sourceHash covers - never a fresh fetch. Returns False (and writes
    nothing) if that day can't be reproduced from them.
    """
    if not records:
        return False
    output_dir.mkdir(parents=True, exist_ok=True)
    latest = records[-1]
    metric_path = METRICS_DIR / f"{PRICE_METRIC_ID}__{latest['marketDay']}.json"
    try:
        metric = json.loads(metric_path.read_text(encoding="utf-8"))
        hourly = pd.concat(
            [pd.read_json(RAW_DIR / name, orient="records") for name in metric["sourceFiles"]],
            ignore_index=True,
        )
        swing = hourly_swing(hourly, latest["marketDay"], latest["value"])
    except (OSError, KeyError, ValueError) as exc:
        print(f"SKIPPED price summary: {exc}", file=sys.stderr)
        return False
    summary = {
        "latestDay": {
            "dayKey": latest["dayKey"],
            "marketDay": latest["marketDay"],
            "value": latest["value"],
            **swing,
        },
        "range": price_range(records),
    }
    path = output_dir / "price-summary.json"
    path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metric", action="append", choices=EXPECTED_METRICS)
    parser.add_argument("--out", type=Path, default=WEB_DATA_DIR)
    parser.add_argument("--generated-out", type=Path, default=WEB_GENERATED_DIR)
    args = parser.parse_args(argv)
    collect_args = argparse.Namespace(metric=args.metric, start=None, end=None, days=None)

    readings, invalid = collect_readings(collect_args)
    for failure in invalid:
        print(f"SKIPPED {failure}", file=sys.stderr)

    ledger = load_ledger()
    by_metric = aggregate(readings, ledger)
    write_aggregates(args.out, by_metric)
    write_addresses(args.out)
    write_feed_meta(args.out)
    write_evidence(args.out)
    summary_written = write_price_summary(args.generated_out, by_metric.get(PRICE_METRIC_ID, []))
    candle_counts = write_price_candles(args.out, by_metric.get(PRICE_METRIC_ID, []))

    total = sum(len(records) for records in by_metric.values())
    submitted = sum(1 for records in by_metric.values() for record in records if record["txHash"])
    print(f"Wrote {len(by_metric)} metric file(s) to {args.out}")
    print(f"  {submitted} of {total} metric-days have a ledger txHash")
    print(f"  {candle_counts['candles']} daily price candles, {candle_counts['skipped']} day(s) skipped")
    if invalid:
        print(f"  {len(invalid)} local file(s) skipped as invalid", file=sys.stderr)
    return 1 if invalid or not summary_written else 0


if __name__ == "__main__":
    raise SystemExit(main())
