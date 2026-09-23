#!/usr/bin/env python3
"""Check one GridOracle reading against its committed file and, on request,
against a fresh copy of ERCOT's published prices.

    python3 verify_reading.py --day-key 20260908
    python3 verify_reading.py --day-key 20260908 --fetch
    python3 verify_reading.py --day-key 20260812 --metric ERCOT_WEST_NORTH_DA_BASIS --fetch

Three checks, each printed as PASS, FAIL or SKIP:

1. chain vs file: the value and sourceHash the oracle holds for (metricId,
   dayKey) equal the committed data/metrics/<metricId>__<day>.json. The
   oracle's finalized flag is printed too.
2. sourceHash: if every file in the metric's ``sourceFiles`` list is present
   under data/raw/, they are hashed in that order (the rule in
   shared/metrics.md) and the digest is compared with the committed hash.
   Without those files this is SKIP, not FAIL: the raw responses are not
   committed to the repository, so this check is for whoever holds them.
3. recompute (``--fetch`` only, needs GRIDSTATUS_API_KEY): the market day's
   hourly day-ahead prices are read again from GridStatus, in memory, never
   written to the cache, and the metric is recomputed with the same functions
   fetch_ercot.py uses. The result is compared with the oracle's value. This
   is the check anyone can run without our raw files: the same public
   prices, the same rule, the same number.

Read-only. No key other than the GridStatus one is ever loaded, and nothing
is sent to the chain. Exit status is 0 when no check FAILs.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from web3 import Web3

import fetch_ercot
from create_markets import load_abi, load_addresses
from publish import DEFAULT_RPC_URL, PublisherError, load_json, make_web3

ROOT = Path(__file__).resolve().parent
METRICS_DIR = ROOT / "data" / "metrics"
RAW_DIR = ROOT / "data" / "raw"

CONTRACT_METRICS = ("ERCOT_HBNORTH_DA_AVG", "ERCOT_WEST_NORTH_DA_BASIS")
FILE_ONLY_METRICS = ("ERCOT_LOAD_WEIGHTED_DA_INDEX", "ERCOT_HBWEST_NEG_INTERVALS")
KNOWN_METRICS = CONTRACT_METRICS + FILE_ONLY_METRICS

PASS, FAIL, SKIP = "PASS", "FAIL", "SKIP"


@dataclass(frozen=True)
class ChainReading:
    value: int
    source_hash: str
    published_at: int
    finalized: bool


@dataclass
class Report:
    lines: list[str]
    failed: bool = False

    def check(self, name: str, status: str, detail: str) -> None:
        self.lines.append(f"  {status:<4} {name}: {detail}")
        if status == FAIL:
            self.failed = True


def parse_day_key(text: str) -> int:
    try:
        value = int(text)
        date(value // 10_000, value // 100 % 100, value % 100)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("expected a real date in YYYYMMDD form") from exc
    return value


def day_key_date(day_key: int) -> date:
    return date(day_key // 10_000, day_key // 100 % 100, day_key % 100)


def metric_file_path(metric_id: str, day_key: int) -> Path:
    return METRICS_DIR / f"{metric_id}__{day_key_date(day_key).isoformat()}.json"


def load_metric_file(metric_id: str, day_key: int) -> dict[str, Any] | None:
    path = metric_file_path(metric_id, day_key)
    if not path.exists():
        return None
    return load_json(path)


def read_chain(w3: Web3, oracle_address: str, metric_id: str, day_key: int) -> ChainReading | None:
    oracle = w3.eth.contract(address=oracle_address, abi=load_abi("GridOracle"))
    metric_hash = Web3.keccak(text=metric_id)
    reading = oracle.functions.getReading(metric_hash, day_key).call()
    # Reading(metricId, dayKey, marketDayStartUtc, marketDayEndUtc, value,
    # sourceHash, publishedAt, finalized)
    published_at = int(reading[6])
    if published_at == 0:
        return None
    source_hash = bytes(reading[5]).hex()
    return ChainReading(
        value=int(reading[4]),
        source_hash=source_hash,
        published_at=published_at,
        finalized=bool(reading[7]),
    )


def format_value(cents: int, metric_id: str) -> str:
    if metric_id == "ERCOT_HBWEST_NEG_INTERVALS":
        return f"{cents} intervals"
    sign = "+" if metric_id == "ERCOT_WEST_NORTH_DA_BASIS" and cents >= 0 else ""
    return f"{sign}${cents / 100:.2f}/MWh"


def recompute_source_hash(metric_id: str, source_files: list[str], raw_dir: Path) -> str | None:
    """The committed hash rule from shared/metrics.md, or None when a file is missing."""
    paths = [raw_dir / name for name in source_files]
    if any(not path.exists() for path in paths):
        return None
    if metric_id == "ERCOT_WEST_NORTH_DA_BASIS":
        # sha256(hash_west + hash_north): each leg is the digest of its own
        # chunk files in order, and the legs are listed West first.
        west = [p for p in paths if "__HB_WEST__" in p.name]
        north = [p for p in paths if "__HB_NORTH__" in p.name]
        if not west or not north or len(west) + len(north) != len(paths):
            return None
        return hashlib.sha256((_digest(west) + _digest(north)).encode()).hexdigest()
    if metric_id in ("ERCOT_HBNORTH_DA_AVG", "ERCOT_HBWEST_NEG_INTERVALS"):
        return _digest(paths)
    return None


def _digest(paths: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.read_bytes())
    return digest.hexdigest()


def fetch_day(client, dataset: str, location: str, day: date):
    """One market day of one dataset, straight from GridStatus, never cached."""
    start, end = str(day), str(day + timedelta(days=1))
    return fetch_ercot.fetch_span(client, dataset, start, end, location)


def recompute_from_gridstatus(client, metric_id: str, day: date) -> tuple[int | None, list[str]]:
    """(value, notes) for the day, recomputed with fetch_ercot.py's own functions."""
    notes: list[str] = []
    if metric_id == "ERCOT_HBNORTH_DA_AVG":
        spec = fetch_ercot.DAY_AHEAD
        df = fetch_day(client, spec["dataset"], spec["location"], day)
        notes.append(f"{len(df)} hourly rows returned for {spec['location']}")
        if len(df):
            prices = ", ".join(f"{p:.2f}" for p in df[spec["price_column"]].tolist())
            notes.append(f"hourly prices: {prices}")
        result = fetch_ercot.day_ahead_average(df).get(day)
        return (result["value"] if result else None), notes
    if metric_id == "ERCOT_WEST_NORTH_DA_BASIS":
        west_spec, north_spec = fetch_ercot.BASIS, fetch_ercot.DAY_AHEAD
        df_west = fetch_day(client, west_spec["dataset"], west_spec["location"], day)
        df_north = fetch_day(client, north_spec["dataset"], north_spec["location"], day)
        notes.append(f"{len(df_west)} West rows, {len(df_north)} North rows returned")
        result = fetch_ercot.basis_spread(df_west, df_north).get(day)
        if result:
            notes.append(f"West mean {result['west']:.2f}, North mean {result['north']:.2f}")
        return (result["value"] if result else None), notes
    raise PublisherError(f"--fetch supports the two contract metrics only, not {metric_id}.")


def run(args: argparse.Namespace) -> Report:
    metric_id: str = args.metric
    day_key: int = args.day_key
    day = day_key_date(day_key)
    report = Report(lines=[])

    addresses = load_addresses()
    w3 = make_web3(os.environ.get("XLAYER_RPC_URL", DEFAULT_RPC_URL))
    chain_id = w3.eth.chain_id
    if chain_id != addresses["chainId"]:
        raise PublisherError(
            f"RPC reports chain {chain_id}; expected X Layer testnet {addresses['chainId']}."
        )

    print(f"GRIDFLEX verify_reading: {metric_id} for {day.isoformat()} (dayKey {day_key})")
    print(f"  Oracle: {addresses['oracle']} on chain {chain_id}")

    chain = read_chain(w3, addresses["oracle"], metric_id, day_key)
    committed = load_metric_file(metric_id, day_key)

    if chain is None:
        print("  Chain:  nothing published for this metric and day")
    else:
        state = "finalized" if chain.finalized else "published, dispute window open or unfinalized"
        print(f"  Chain:  {format_value(chain.value, metric_id)} ({chain.value}), {state}")
        print(f"          sourceHash {chain.source_hash}")
    if committed is None:
        print(f"  File:   {metric_file_path(metric_id, day_key).relative_to(ROOT)} not found")
    else:
        print(f"  File:   {format_value(int(committed['value']), metric_id)} ({committed['value']})")
        print(f"          sourceHash {committed['sourceHash']}")
    print()

    # 1. chain vs file
    if chain is None or committed is None:
        report.check("chain vs file", SKIP, "needs both a published reading and a committed file")
    else:
        same_value = chain.value == int(committed["value"])
        same_hash = chain.source_hash.lower() == str(committed["sourceHash"]).lower()
        if same_value and same_hash:
            report.check("chain vs file", PASS, "value and sourceHash match")
        else:
            report.check(
                "chain vs file", FAIL,
                f"value {'matches' if same_value else 'differs'}, "
                f"sourceHash {'matches' if same_hash else 'differs'}",
            )

    # 2. sourceHash from local raw files
    if committed is None:
        report.check("sourceHash", SKIP, "no committed file")
    else:
        recomputed = recompute_source_hash(
            metric_id, list(committed.get("sourceFiles", [])), args.raw_dir
        )
        if recomputed is None:
            report.check(
                "sourceHash", SKIP,
                f"not every file in sourceFiles is under {args.raw_dir}; the raw "
                "responses are not committed, so only their holder can run this",
            )
        elif recomputed.lower() == str(committed["sourceHash"]).lower():
            report.check("sourceHash", PASS, f"{len(committed['sourceFiles'])} raw files hash to the committed value")
        else:
            report.check("sourceHash", FAIL, f"raw files hash to {recomputed}")

    # 3. recompute from GridStatus
    if not args.fetch:
        report.check("recompute", SKIP, "pass --fetch to re-read the day's prices from GridStatus")
    elif metric_id not in CONTRACT_METRICS:
        report.check("recompute", SKIP, "only the two contract metrics are recomputed")
    else:
        client = fetch_ercot.get_client()
        value, notes = recompute_from_gridstatus(client, metric_id, day)
        for note in notes:
            print(f"  {note}")
        target = chain.value if chain is not None else (int(committed["value"]) if committed else None)
        where = "oracle" if chain is not None else "committed file"
        if value is None:
            report.check("recompute", FAIL, "GridStatus returned an incomplete day; nothing to compare")
        elif target is None:
            report.check("recompute", SKIP, f"recomputed {format_value(value, metric_id)}; nothing published or committed to compare")
        elif value == target:
            report.check("recompute", PASS, f"GridStatus prices give {format_value(value, metric_id)}, the {where}'s value")
        else:
            report.check(
                "recompute", FAIL,
                f"GridStatus prices give {format_value(value, metric_id)} ({value}); "
                f"the {where} holds {format_value(target, metric_id)} ({target})",
            )
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--day-key", type=parse_day_key, required=True, help="YYYYMMDD, e.g. 20260908")
    parser.add_argument(
        "--metric", default="ERCOT_HBNORTH_DA_AVG", choices=KNOWN_METRICS,
        help="metricId (default ERCOT_HBNORTH_DA_AVG)",
    )
    parser.add_argument(
        "--fetch", action="store_true",
        help="re-read the day's prices from GridStatus and recompute the metric (needs GRIDSTATUS_API_KEY)",
    )
    parser.add_argument(
        "--raw-dir", type=Path, default=RAW_DIR,
        help="where to look for the files in sourceFiles (default data/raw)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        report = run(args)
    except (PublisherError, SystemExit) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("ERROR: Interrupted by operator.", file=sys.stderr)
        return 1
    print("\n".join(report.lines))
    print()
    print("Result: " + ("FAIL" if report.failed else "OK (no check failed)"))
    return 1 if report.failed else 0


if __name__ == "__main__":
    sys.exit(main())
