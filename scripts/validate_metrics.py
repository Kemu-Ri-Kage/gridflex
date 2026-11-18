#!/usr/bin/env python3
"""Validate metric JSONs before they are committed, pushed, deployed or
published on chain (daily-settle spec §14, audit finding S7).

  python scripts/validate_metrics.py                  every file, structure only
  python scripts/validate_metrics.py --files A B      only these files
  python scripts/validate_metrics.py --range-min -5000 --range-max 100000
                                                      also bound the price metrics
                                                      (cents per MWh)
  python scripts/validate_metrics.py --provenance     also recompute sourceHash
                                                      from data/raw/<sourceFiles>
                                                      and the value from those rows

Exit 0 only when every checked file passes. Structure needs no API
credentials or raw files; --provenance needs the raw cache.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
METRICS_DIR = ROOT / "data" / "metrics"
RAW_DIR = ROOT / "data" / "raw"
# Price metrics, in cents per MWh, that the range check bounds. The default
# band is the one settle_due.py holds finalizing on (decision D4).
PRICE_METRICS = {"ERCOT_HBNORTH_DA_AVG", "ERCOT_LOAD_WEIGHTED_DA_INDEX", "ERCOT_WEST_NORTH_DA_BASIS"}
RANGE_MIN_CENTS = -5_000      # -$50/MWh
RANGE_MAX_CENTS = 100_000     # $1,000/MWh
# Metrics whose sourceHash is sha256 over the raw files themselves, so it
# can be recomputed; derived metrics hash other hashes and cannot.
PROVENANCE_METRICS = {"ERCOT_HBNORTH_DA_AVG"}
RAW_NAME_RE = re.compile(r"^[A-Za-z0-9_]+__[A-Za-z0-9_]+__\d{4}-\d{2}-\d{2}__\d{4}-\d{2}-\d{2}\.json$")


class ProvenanceError(ValueError):
    """The file can't be traced to the raw data it claims. The message always
    starts with PROVENANCE, a stop word for the settle job."""

    def __init__(self, reason: str):
        super().__init__(f"PROVENANCE: {reason}")
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


def check_range(path: Path, low: int = RANGE_MIN_CENTS, high: int = RANGE_MAX_CENTS) -> None:
    """A price metric outside low..high cents/MWh is refused."""
    record = json.loads(path.read_text(encoding="utf-8"))
    if record.get("metricId") in PRICE_METRICS and not low <= record["value"] <= high:
        raise ValueError(f"value {record['value']} is outside {low}..{high} cents/MWh")


def verify_provenance(path: Path, raw_dir: Path | None = None) -> None:
    """Recompute the file's sourceHash from raw_dir/<sourceFiles>, in order,
    and its value and day bounds from those raw rows, exactly as
    fetch_ercot.py computed them. Any gap or difference is a ProvenanceError."""
    raw_dir = raw_dir or RAW_DIR
    try:
        metric_id, day_key = validate(path)
    except ValueError as exc:
        raise ProvenanceError(f"{path.name} is not a valid metric file ({exc})") from exc
    record = json.loads(path.read_text(encoding="utf-8"))
    if metric_id not in PROVENANCE_METRICS:
        raise ProvenanceError(f"{metric_id} has no reproducible sourceHash")
    digest = hashlib.sha256()
    paths = []
    for name in record["sourceFiles"]:
        if not RAW_NAME_RE.fullmatch(name):
            raise ProvenanceError(f"{path.name}: source file name {name!r} is not a raw cache file")
        source = raw_dir / name
        if not source.is_file():
            raise ProvenanceError(f"{path.name}: raw file {name} is missing from {raw_dir}")
        digest.update(source.read_bytes())
        paths.append(source)
    if digest.hexdigest() != record["sourceHash"]:
        raise ProvenanceError(f"{path.name}: sourceHash does not reproduce from its raw files")

    # The value itself, from the same rows, by fetch_ercot's own function.
    import pandas as pd  # noqa: PLC0415 - only --provenance needs pandas
    sys.path.insert(0, str(ROOT))
    import fetch_ercot  # noqa: PLC0415

    frames = [pd.read_json(p, orient="records") for p in paths]
    frames = [f for f in frames if len(f)]
    if not frames:
        raise ProvenanceError(f"{path.name}: its raw files hold no rows")
    days = fetch_ercot.day_ahead_average(pd.concat(frames, ignore_index=True))
    day = _date_from_day_key(day_key)
    computed = days.get(day)
    if computed is None:
        raise ProvenanceError(f"{path.name}: its raw files have no complete day {day}")
    if (computed["value"], computed["start_utc"], computed["end_utc"]) != (
            record["value"], record["marketDayStartUtc"], record["marketDayEndUtc"]):
        raise ProvenanceError(
            f"{path.name}: value {record['value']} does not match {computed['value']} recomputed from raw")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--files", nargs="+", type=Path, help="check only these metric files")
    parser.add_argument("--range-min", type=int, help="lowest allowed price, cents/MWh")
    parser.add_argument("--range-max", type=int, help="highest allowed price, cents/MWh")
    parser.add_argument("--provenance", action="store_true",
                        help="recompute sourceHash and value from data/raw")
    parser.add_argument("--raw-dir", type=Path, default=None, help="raw cache (default data/raw)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if (args.range_min is None) != (args.range_max is None):
        print("--range-min and --range-max go together", file=sys.stderr)
        return 2
    files = sorted(args.files) if args.files else sorted(METRICS_DIR.glob("*.json"))
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
            if args.range_min is not None:
                check_range(path, args.range_min, args.range_max)
            if args.provenance and key[0] in PROVENANCE_METRICS:
                verify_provenance(path, args.raw_dir)
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
