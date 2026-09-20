#!/usr/bin/env python3
"""Validate committed metric JSONs without API credentials or raw files."""

from __future__ import annotations

import json
import re
import sys
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
METRICS_DIR = ROOT / "data" / "metrics"
CENTRAL = ZoneInfo("America/Chicago")
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
REQUIRED = {
    "metricId",
    "dayKey",
    "marketDay",
    "marketDayStartUtc",
    "marketDayEndUtc",
    "value",
    "sourceHash",
    "sourceFiles",
    "hashAlgorithm",
}
FORBIDDEN = {"periodStart", "periodEnd"}


def _plain_int(value: object) -> bool:
    return type(value) is int


def _date_from_day_key(day_key: int) -> date:
    text = str(day_key)
    if len(text) != 8:
        raise ValueError("dayKey must be an 8-digit YYYYMMDD integer")
    try:
        return datetime.strptime(text, "%Y%m%d").date()
    except ValueError as exc:
        raise ValueError("dayKey must encode a real calendar date") from exc


def validate(path: Path) -> tuple[str, int]:
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid JSON: {exc}") from exc

    missing = REQUIRED - record.keys()
    if missing:
        raise ValueError(f"missing keys: {', '.join(sorted(missing))}")
    forbidden = FORBIDDEN & record.keys()
    if forbidden:
        raise ValueError(f"obsolete keys present: {', '.join(sorted(forbidden))}")

    metric_id = record["metricId"]
    day_key = record["dayKey"]
    market_day = record["marketDay"]
    start_utc = record["marketDayStartUtc"]
    end_utc = record["marketDayEndUtc"]
    value = record["value"]
    source_hash = record["sourceHash"]
    source_files = record["sourceFiles"]

    if not isinstance(metric_id, str) or not metric_id:
        raise ValueError("metricId must be a non-empty string")
    if not _plain_int(day_key):
        raise ValueError("dayKey must be an integer")
    expected_day = _date_from_day_key(day_key)
    if market_day != expected_day.isoformat():
        raise ValueError("marketDay must match dayKey")
    if not _plain_int(start_utc) or not _plain_int(end_utc):
        raise ValueError("market-day UTC bounds must be integers")
    if start_utc < 0 or end_utc <= start_utc:
        raise ValueError("marketDayEndUtc must be after marketDayStartUtc")
    start_central = datetime.fromtimestamp(start_utc, tz=CENTRAL)
    end_central = datetime.fromtimestamp(end_utc, tz=CENTRAL)
    if start_central.date() != expected_day or (
        start_central.hour,
        start_central.minute,
        start_central.second,
    ) != (0, 0, 0):
        raise ValueError("marketDayStartUtc must be Central midnight for dayKey")

    next_day = date.fromordinal(expected_day.toordinal() + 1)
    next_midnight = datetime(next_day.year, next_day.month, next_day.day, tzinfo=CENTRAL)
    expected_end_utc = int(next_midnight.timestamp())
    full_duration = expected_end_utc - start_utc
    duration = end_utc - start_utc
    if metric_id.startswith("ERCOT_FUELMIX_"):
        if end_utc > expected_end_utc or duration < full_duration * 0.95:
            raise ValueError("fuel-mix day must have at least 95% coverage")
    elif end_utc != expected_end_utc or full_duration not in {
        23 * 3600,
        24 * 3600,
        25 * 3600,
    }:
        raise ValueError("complete metric day must end at the next Central midnight")

    if not _plain_int(value):
        raise ValueError("value must be a signed integer")
    if record["hashAlgorithm"] != "sha256" or not isinstance(source_hash, str):
        raise ValueError("hashAlgorithm/sourceHash must describe SHA-256")
    if not HASH_RE.fullmatch(source_hash):
        raise ValueError("sourceHash must be 64 lowercase hexadecimal characters")
    if not isinstance(source_files, list) or not source_files:
        raise ValueError("sourceFiles must be a non-empty ordered list")
    if any(not isinstance(item, str) or not item for item in source_files):
        raise ValueError("every sourceFiles item must be a non-empty string")

    expected_prefix = f"{metric_id}__"
    if not path.stem.startswith(expected_prefix):
        raise ValueError("filename metricId does not match record")
    filename_date = path.stem.removeprefix(expected_prefix)
    if filename_date != market_day:
        raise ValueError("filename date does not match marketDay")

    return metric_id, day_key


def main() -> int:
    files = sorted(METRICS_DIR.glob("*.json"))
    if not files:
        print(f"No metric files found in {METRICS_DIR}", file=sys.stderr)
        return 1

    seen: set[tuple[str, int]] = set()
    failures: list[str] = []
    for path in files:
        try:
            key = validate(path)
            if key in seen:
                raise ValueError(f"duplicate metric day: {key[0]} @ {key[1]}")
            seen.add(key)
        except ValueError as exc:
            failures.append(f"{path.name}: {exc}")

    if failures:
        print("Metric validation failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    metric_count = len({metric_id for metric_id, _ in seen})
    print(f"Validated {len(files)} JSON files across {metric_count} metrics.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
