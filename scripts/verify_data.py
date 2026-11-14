#!/usr/bin/env python3
"""Approve, or refuse, the data feat/judging-sprint holds beyond the reviewed
main commit (daily-settle spec §14, audit finding S3).

ops/code-matches-main.sh --allow-verified lets three address-bearing files
differ from main only if this script approves them. It is read-only, runs
main's copy (the code check has just proved the working tree's code is
main's), reads both sides from git (never the working tree), and fails
closed: any file it can't read, and any chain read that fails, is a refusal.

Relative to <base> (the reviewed main commit) it enforces:

  shared/addresses.json   every top-level key other than "markets" equal to
                          base's; "markets" is base's list, unchanged and in
                          order, plus appended entries only. Each appended
                          market, read from the chain at one block:
                            listed by the pinned factory's getMarkets();
                            oracle() is the pinned active oracle and
                            collateral() the pinned collateral;
                            metricId() a pinned metric; dayKey(), threshold(),
                            resolveAfter(), disputeWindow(), yesToken() and
                            noToken() equal the entry.
  data/market-ledger.json base's rows unchanged, plus rows for exactly the
                          appended markets, with the same terms.
  shared/demo-markets.md  base's text unchanged; appended Summary-table rows
                          only, one for each appended market (metric, day,
                          strike).
  web/public/data/addresses.json
                          equal to base's copy, or to build_feed_data's
                          write_addresses() of the verified addresses.json;
                          never trusted as written.
  data/metrics/*          a changed file whose day is already on chain must
                          carry the chain's value and sourceHash.

  python scripts/verify_data.py --base <sha>

Exit codes: 0 approved, 1 refused, 2 could not read the files or the chain.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Protocol

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from web3 import Web3  # noqa: E402

import chain_guard  # noqa: E402

ADDRESSES = "shared/addresses.json"
LEDGER = "data/market-ledger.json"
DEMO = "shared/demo-markets.md"
SITE_ADDRESSES = "web/public/data/addresses.json"
PINS = "shared/pins.json"
METRIC_RE = re.compile(r"^data/metrics/([A-Za-z0-9_]+)__(\d{4})-(\d{2})-(\d{2})\.json$")
ROW_RE = re.compile(r"^\|\s*(\d+)\s*\|\s*`([A-Z0-9_]+)`\s*\|\s*>\s*\$(-?\d+(?:\.\d{1,2})?)\s*\|\s*`(\d{8})`\s*\|")
# Terms the chain, the addresses entry and the ledger row must agree on.
TERMS = ("metricId", "dayKey", "threshold", "resolveAfter", "disputeWindow", "yesToken", "noToken")


class Refused(Exception):
    """The data is not approved."""


class Unreadable(Exception):
    """A file or the chain could not be read."""


class ChainReader(Protocol):
    def chain_id(self) -> int: ...
    def factory_markets(self, factory: str) -> set[str]: ...
    def market(self, address: str) -> dict[str, Any]: ...
    def reading(self, metric_id: str, day_key: int) -> tuple[int, str] | None: ...


# ------------------------------------------------------------------ git

def git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)


def show(repo: Path, rev: str, path: str) -> str | None:
    result = git(repo, "show", f"{rev}:{path}")
    if result.returncode != 0:
        if "does not exist" in result.stderr or "exists on disk, but not in" in result.stderr:
            return None
        raise Unreadable(f"git show {rev}:{path}: {result.stderr.strip()}")
    return result.stdout


def show_json(repo: Path, rev: str, path: str) -> Any:
    text = show(repo, rev, path)
    if text is None:
        raise Unreadable(f"{rev}:{path} does not exist")
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise Refused(f"{path} at {rev} is not valid JSON: {exc}") from exc


def changed_paths(repo: Path, base: str) -> list[str]:
    result = git(repo, "diff", "--name-only", "--no-renames", base, "HEAD", "--")
    if result.returncode != 0:
        raise Unreadable(f"git diff {base} HEAD: {result.stderr.strip()}")
    return [line for line in result.stdout.splitlines() if line]


def refuse_dirty(repo: Path) -> None:
    paths = (ADDRESSES, LEDGER, DEMO, SITE_ADDRESSES, PINS, "data/metrics")
    result = git(repo, "status", "--porcelain", "--untracked-files=all", "--", *paths)
    if result.returncode != 0:
        raise Unreadable(f"git status: {result.stderr.strip()}")
    if result.stdout.strip():
        raise Refused("uncommitted changes in verified paths:\n" + result.stdout.rstrip())


# ------------------------------------------------------------------ pure checks

def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def appended_markets(base: dict[str, Any], head: dict[str, Any]) -> list[dict[str, Any]]:
    """addresses.json: core keys untouched, markets append-only."""
    if not isinstance(head, dict) or not isinstance(head.get("markets"), list):
        raise Refused(f"{ADDRESSES}: must be an object with a markets list")
    base_core = {k: v for k, v in base.items() if k != "markets"}
    head_core = {k: v for k, v in head.items() if k != "markets"}
    if set(base_core) != set(head_core):
        raise Refused(f"{ADDRESSES}: top-level keys changed "
                      f"(added {sorted(set(head_core) - set(base_core))}, "
                      f"removed {sorted(set(base_core) - set(head_core))})")
    for key in sorted(base_core):
        if canonical(base_core[key]) != canonical(head_core[key]):
            raise Refused(f"{ADDRESSES}: top-level {key!r} differs from main")
    base_markets, head_markets = base.get("markets", []), head["markets"]
    if len(head_markets) < len(base_markets):
        raise Refused(f"{ADDRESSES}: markets were removed ({len(base_markets)} on main, {len(head_markets)} here)")
    for i, (old, new) in enumerate(zip(base_markets, head_markets)):
        if canonical(old) != canonical(new):
            raise Refused(f"{ADDRESSES}: existing market #{i + 1} ({old.get('market')}) was edited, moved or replaced")
    appended = head_markets[len(base_markets):]
    seen = set()
    for entry in head_markets:
        address = entry.get("market") if isinstance(entry, dict) else None
        if not isinstance(address, str) or not Web3.is_address(address):
            raise Refused(f"{ADDRESSES}: market entry {entry!r} has no valid address")
        if address.lower() in seen:
            raise Refused(f"{ADDRESSES}: market {address} is listed twice")
        seen.add(address.lower())
    for entry in appended:
        for field in TERMS:
            if field not in entry:
                raise Refused(f"{ADDRESSES}: appended market {entry['market']} has no {field}")
    return appended


def appended_ledger_rows(base: dict[str, Any], head: dict[str, Any],
                         appended: list[dict[str, Any]]) -> None:
    """market-ledger.json: append-only, and exactly the appended markets."""
    if not isinstance(head, dict):
        raise Refused(f"{LEDGER}: must be a JSON object")
    for key, row in base.items():
        if key not in head:
            raise Refused(f"{LEDGER}: row {key} was removed")
        if canonical(head[key]) != canonical(row):
            raise Refused(f"{LEDGER}: row {key} was edited")
    new_rows = {key: head[key] for key in head if key not in base}
    by_address = {}
    for key, row in new_rows.items():
        if not isinstance(row, dict) or not isinstance(row.get("market"), str):
            raise Refused(f"{LEDGER}: new row {key} has no market")
        by_address[row["market"].lower()] = (key, row)
    wanted = {m["market"].lower(): m for m in appended}
    if set(by_address) != set(wanted):
        extra = sorted(set(by_address) - set(wanted))
        missing = sorted(set(wanted) - set(by_address))
        raise Refused(f"{LEDGER}: new rows are not exactly the appended markets "
                      f"(not in the ledger: {missing}; only in the ledger: {extra})")
    for address, (key, row) in by_address.items():
        entry = wanted[address]
        for field in TERMS:
            if str(row.get(field)) != str(entry.get(field)):
                raise Refused(f"{LEDGER}: row {key} {field} differs from {ADDRESSES}")
        if key != f"{row['metricId']}:{row['dayKey']}:{row['threshold']}":
            raise Refused(f"{LEDGER}: row key {key} does not name its own terms")


def table_rows(text: str) -> list[tuple[int, str, int, int]]:
    """(row, metricId, dayKey, threshold cents) of each Summary-table line."""
    rows = []
    for line in text.splitlines():
        match = ROW_RE.match(line)
        if match:
            dollars = match.group(3)
            cents = int(round(float(dollars) * 100))
            rows.append((int(match.group(1)), match.group(2), int(match.group(4)), cents))
    return rows


def appended_demo_rows(base_text: str, head_text: str, appended: list[dict[str, Any]]) -> None:
    """demo-markets.md: base unchanged, appended table rows only, one per new market."""
    base_lines, head_lines = base_text.splitlines(), head_text.splitlines()
    last_row = max((i for i, line in enumerate(base_lines) if ROW_RE.match(line)), default=None)
    if last_row is None:
        raise Refused(f"{DEMO}: main's copy has no Summary table rows")
    added = len(head_lines) - len(base_lines)
    if added < 0 or head_lines[:last_row + 1] != base_lines[:last_row + 1] \
            or head_lines[last_row + 1 + added:] != base_lines[last_row + 1:]:
        raise Refused(f"{DEMO}: main's rows or text were changed; only appended table rows are data")
    new_lines = head_lines[last_row + 1:last_row + 1 + added]
    new_rows = table_rows("\n".join(new_lines))
    if len(new_rows) != len(new_lines):
        raise Refused(f"{DEMO}: an appended line is not a Summary-table row")
    numbers = [r[0] for r in table_rows(base_text)] + [r[0] for r in new_rows]
    if len(set(numbers)) != len(numbers) or [r[0] for r in new_rows] != list(
            range(max(numbers[:len(numbers) - len(new_rows)]) + 1, max(numbers) + 1)):
        raise Refused(f"{DEMO}: appended rows are not numbered on from main's last row")
    row_terms = sorted((r[1], r[2], r[3]) for r in new_rows)
    market_terms = sorted((m["metricId"], int(m["dayKey"]), int(m["threshold"])) for m in appended)
    if row_terms != market_terms:
        raise Refused(f"{DEMO}: appended rows do not match the appended markets one to one")


def expected_site_addresses(head_addresses: dict[str, Any]) -> str:
    """build_feed_data.write_addresses() of the verified addresses.json."""
    import build_feed_data  # noqa: PLC0415 - pandas only when needed
    from unittest.mock import patch  # noqa: PLC0415
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "addresses.json"
        source.write_text(json.dumps(head_addresses), encoding="utf-8")
        out = Path(directory) / "out"
        out.mkdir()
        with patch.object(build_feed_data, "ADDRESSES_SOURCE", source):
            build_feed_data.write_addresses(out)
        return (out / "addresses.json").read_text(encoding="utf-8")


def verify_market_on_chain(entry: dict[str, Any], chain: dict[str, Any], listed: set[str],
                           pins: chain_guard.Pins) -> None:
    address = Web3.to_checksum_address(entry["market"])
    if address not in listed:
        raise Refused(f"market {address} is not listed by the pinned MarketFactory {pins.factory}")
    if Web3.to_checksum_address(chain["oracle"]) != pins.active_oracle:
        raise Refused(f"market {address}: oracle() {chain['oracle']} is not the pinned {pins.active_oracle}")
    if Web3.to_checksum_address(chain["collateral"]) != pins.collateral:
        raise Refused(f"market {address}: collateral() {chain['collateral']} is not the pinned {pins.collateral}")
    name = pins.metric_hashes().get(chain["metricId"])
    if name is None or name != entry["metricId"]:
        raise Refused(f"market {address}: metricId() is not the pinned {entry['metricId']}")
    for field in ("dayKey", "threshold", "resolveAfter", "disputeWindow"):
        if int(chain[field]) != int(entry[field]):
            raise Refused(f"market {address}: {field}() {chain[field]} != {entry[field]}")
    for field in ("yesToken", "noToken"):
        if Web3.to_checksum_address(chain[field]) != Web3.to_checksum_address(entry[field]):
            raise Refused(f"market {address}: {field}() differs from the entry")


# ------------------------------------------------------------------ the whole check

def verify(repo: Path, base: str, reader: ChainReader) -> list[str]:
    """Approve HEAD's data against base, or raise Refused/Unreadable."""
    refuse_dirty(repo)
    pins_text = show(repo, base, PINS)
    if pins_text is None:
        raise Unreadable(f"{base}:{PINS} does not exist")
    with tempfile.TemporaryDirectory() as directory:
        pins_path = Path(directory) / "pins.json"
        pins_path.write_text(pins_text, encoding="utf-8")
        pins = chain_guard.load_pins(pins_path)

    base_addresses = show_json(repo, base, ADDRESSES)
    head_addresses = show_json(repo, "HEAD", ADDRESSES)
    legacy = [e.get("address") for e in head_addresses.get("legacyDeployments", {}).get("MarketFactory", []) or []]
    chain_guard.assert_addresses_match_pins(int(head_addresses.get("chainId", 0)), head_addresses.get("GridOracle", ""),
                                            head_addresses.get("MarketFactory"), head_addresses.get("MockUSDT"),
                                            legacy, pins)
    appended = appended_markets(base_addresses, head_addresses)
    appended_ledger_rows(show_json(repo, base, LEDGER), show_json(repo, "HEAD", LEDGER), appended)
    base_demo, head_demo = show(repo, base, DEMO), show(repo, "HEAD", DEMO)
    if base_demo is None or head_demo is None:
        raise Unreadable(f"{DEMO} is missing")
    appended_demo_rows(base_demo, head_demo, appended)

    site = show(repo, "HEAD", SITE_ADDRESSES)
    if site is not None and site != show(repo, base, SITE_ADDRESSES) \
            and site != expected_site_addresses(head_addresses):
        raise Refused(f"{SITE_ADDRESSES}: neither main's copy nor write_addresses() of the verified {ADDRESSES}")

    notes = [f"{len(appended)} appended market(s)"]
    try:
        if reader.chain_id() != pins.chain_id:
            raise Refused(f"chain is not the pinned chain {pins.chain_id}")
        if appended:
            listed = reader.factory_markets(pins.factory)
            for entry in appended:
                verify_market_on_chain(entry, reader.market(entry["market"]), listed, pins)
        checked = 0
        for path in changed_paths(repo, base):
            match = METRIC_RE.match(path)
            if not match or match.group(1) not in pins.metric_ids:
                continue
            record = show_json(repo, "HEAD", path) if show(repo, "HEAD", path) is not None else None
            if record is None:
                continue
            on_chain = reader.reading(match.group(1), int("".join(match.group(2, 3, 4))))
            checked += 1
            if on_chain is not None and (int(record.get("value")) != on_chain[0] or str(
                    record.get("sourceHash", "")).lower().removeprefix("0x") != on_chain[1]):
                raise Refused(f"{path}: differs from the reading already on chain")
        notes.append(f"{checked} changed metric file(s) checked against the chain")
    except (Refused, Unreadable):
        raise
    except Exception as exc:  # RPC errors arrive as many types
        raise Unreadable(f"chain read failed ({type(exc).__name__}: {exc})") from exc
    return notes


class Web3Reader:
    """Read-only, every call pinned to one block."""

    def __init__(self, w3: Web3):
        from create_markets import load_abi  # noqa: PLC0415
        self.w3 = w3
        self.block = int(w3.eth.get_block("latest")["number"])
        self.abi = {name: load_abi(name) for name in ("BinaryMarket", "MarketFactory", "GridOracle")}

    def chain_id(self) -> int:
        return int(self.w3.eth.chain_id)

    def factory_markets(self, factory: str) -> set[str]:
        contract = self.w3.eth.contract(address=factory, abi=self.abi["MarketFactory"])
        return {Web3.to_checksum_address(a)
                for a in contract.functions.getMarkets().call(block_identifier=self.block)}

    def market(self, address: str) -> dict[str, Any]:
        contract = self.w3.eth.contract(address=Web3.to_checksum_address(address), abi=self.abi["BinaryMarket"])
        out = {}
        for field in ("oracle", "collateral", "metricId", *TERMS[1:]):
            value = getattr(contract.functions, field)().call(block_identifier=self.block)
            out[field] = bytes(value).hex() if field == "metricId" else value
        return out

    def reading(self, metric_id: str, day_key: int) -> tuple[int, str] | None:
        pins = chain_guard.load_pins()
        contract = self.w3.eth.contract(address=pins.active_oracle, abi=self.abi["GridOracle"])
        raw = contract.functions.getReading(Web3.keccak(text=metric_id), day_key).call(block_identifier=self.block)
        if int(raw[6]) == 0:
            return None
        return int(raw[4]), bytes(raw[5]).hex()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--base", required=True, help="the reviewed main commit (e.g. $GITHUB_SHA)")
    args = parser.parse_args(argv)
    try:
        from publish import DEFAULT_RPC_URL, make_web3  # noqa: PLC0415
        reader = Web3Reader(make_web3(os.environ.get("XLAYER_RPC_URL", DEFAULT_RPC_URL)))
        notes = verify(ROOT, args.base, reader)
    except Refused as exc:
        print(f"verify_data: REFUSED: {exc}", file=sys.stderr)
        return 1
    except chain_guard.PinError as exc:
        print(f"verify_data: REFUSED: {exc}", file=sys.stderr)
        return 1
    except Unreadable as exc:
        print(f"verify_data: could not verify: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # the RPC failing while connecting
        print(f"verify_data: could not verify ({type(exc).__name__}): {exc}", file=sys.stderr)
        return 2
    print(f"verify_data: approved against {args.base[:12]}: " + "; ".join(notes))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
