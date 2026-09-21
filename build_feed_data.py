#!/usr/bin/env python3
"""Aggregate committed metric files + the publish ledger for the feed page.

Implements shared/feed-spec.md §9: the feed page never reads the 2,168 raw
data/metrics/*.json files directly, and never depends on a live RPC call to
render anything but its per-row verification badge. This script writes one
small, trimmed file per in-scope metric into web/public/data/ - the only
thing under web/ this script touches, and the only new path it adds.

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

from publish import EXPECTED_METRICS, MetricReading, collect_readings, load_ledger

ROOT = Path(__file__).resolve().parent
WEB_DATA_DIR = ROOT / "web" / "public" / "data"


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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metric", action="append", choices=EXPECTED_METRICS)
    parser.add_argument("--out", type=Path, default=WEB_DATA_DIR)
    args = parser.parse_args(argv)
    collect_args = argparse.Namespace(metric=args.metric, start=None, end=None, days=None)

    readings, invalid = collect_readings(collect_args)
    for failure in invalid:
        print(f"SKIPPED {failure}", file=sys.stderr)

    ledger = load_ledger()
    by_metric = aggregate(readings, ledger)
    write_aggregates(args.out, by_metric)

    total = sum(len(records) for records in by_metric.values())
    submitted = sum(1 for records in by_metric.values() for record in records if record["txHash"])
    print(f"Wrote {len(by_metric)} metric file(s) to {args.out}")
    print(f"  {submitted} of {total} metric-days have a ledger txHash")
    if invalid:
        print(f"  {len(invalid)} local file(s) skipped as invalid", file=sys.stderr)
    return 1 if invalid else 0


if __name__ == "__main__":
    raise SystemExit(main())
