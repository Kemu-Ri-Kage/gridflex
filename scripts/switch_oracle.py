#!/usr/bin/env python3
"""Point GRIDFLEX at a newly deployed GridOracleV2 (shared/oracle-v2.md,
"Switching over").

Dry by default: prints every check and the change it would make to
shared/addresses.json. With --write it makes the change; commit it on a
branch like any data change. Nothing is signed or sent.

It refuses unless, read from the chain:
  - the new address holds a GridOracleV2 with an owner, a reporter and a
    guardian, not paused, whose disputeWindow matches the current oracle's
    (publish.py, finalize.py and the site assume one window);
  - every market in data/market-ledger.json that settles on the current
    oracle is resolved or cancelled, and every data/publish-ledger.json row
    is finalized: nothing is left mid-settlement on the oracle being retired.

The current oracle moves to legacyDeployments.GridOracle as "retired", with
lastDayKey, the latest day it settled or holds a reading for. The site reads
any day up to lastDayKey from it (web/lib/oracle-for-day.ts), and the new
oracle only ever gets later days: the ladder's next market day is after it.

Usage:
  python scripts/switch_oracle.py --oracle 0x... --deploy-tx 0x...
  python scripts/switch_oracle.py --oracle 0x... --deploy-tx 0x... --write
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from web3 import Web3  # noqa: E402

from create_markets import RPC_COURTESY_SLEEP, load_abi, load_addresses  # noqa: E402
from publish import DEFAULT_RPC_URL, PublisherError, load_json, make_web3  # noqa: E402

ADDRESSES_PATH = ROOT / "shared" / "addresses.json"
MARKET_LEDGER = ROOT / "data" / "market-ledger.json"
PUBLISH_LEDGER = ROOT / "data" / "publish-ledger.json"


def unsettled(markets: list[dict[str, Any]], ledger_rows: list[dict[str, Any]]) -> list[str]:
    """Everything still in progress on the oracle being retired, as readable
    lines; empty means it can be retired. `markets` are the current oracle's
    markets with their chain state; `ledger_rows` are publish-ledger rows."""
    problems = [
        f"market {m['market']} ({m['metricId']} {m['dayKey']}) is neither resolved nor cancelled"
        for m in markets if not m["resolved"] and not m["cancelled"]
    ]
    problems += [
        f"reading {row['metricId']} {row['dayKey']} is '{row.get('status')}', not finalized"
        for row in ledger_rows if row.get("status") != "finalized"
    ]
    return problems


def switched_config(config: dict[str, Any], new_oracle: str, deploy_tx: str,
                    roles: dict[str, str], last_day_key: int) -> dict[str, Any]:
    """shared/addresses.json after the switch. Pure: the caller checks first."""
    old_oracle = config["GridOracle"]
    if Web3.to_checksum_address(old_oracle) == Web3.to_checksum_address(new_oracle):
        raise PublisherError("The new oracle is the one already in use.")
    updated = copy.deepcopy(config)
    legacy = updated.setdefault("legacyDeployments", {}).setdefault("GridOracle", [])
    retired = {"address": old_oracle, "lastDayKey": last_day_key, "status": "retired"}
    old_tx = config.get("transactions", {}).get("GridOracle")
    if old_tx:
        retired["transaction"] = old_tx
    legacy.append(retired)
    updated["GridOracle"] = Web3.to_checksum_address(new_oracle)
    updated.setdefault("transactions", {})["GridOracle"] = deploy_tx
    updated["reporter"] = roles["reporter"]
    updated["guardian"] = roles["guardian"]
    updated["oracleOwner"] = roles["owner"]
    return updated


def read_new_oracle(w3: Web3, address: str) -> dict[str, Any]:
    code = w3.eth.get_code(address)
    if not code or code == b"":
        raise PublisherError(f"No contract at {address}.")
    oracle = w3.eth.contract(address=address, abi=load_abi("GridOracleV2"))
    try:
        state = {
            "owner": Web3.to_checksum_address(oracle.functions.owner().call()),
            "reporter": Web3.to_checksum_address(oracle.functions.reporter().call()),
            "guardian": Web3.to_checksum_address(oracle.functions.guardian().call()),
            "paused": bool(oracle.functions.paused().call()),
            "disputeWindow": int(oracle.functions.disputeWindow().call()),
        }
    except Exception as exc:
        raise PublisherError(f"{address} does not answer as a GridOracleV2 ({type(exc).__name__}).") from exc
    if state["reporter"] in (state["owner"], state["guardian"]):
        raise PublisherError("The new oracle's reporter must not be its owner or guardian.")
    if state["paused"]:
        raise PublisherError("The new oracle is paused; the owner must unpause it first.")
    return state


def current_oracle_markets(w3: Web3, oracle: str) -> list[dict[str, Any]]:
    """data/market-ledger.json's markets that settle on `oracle`, with their state."""
    ledger = load_json(MARKET_LEDGER) if MARKET_LEDGER.exists() else {}
    market_abi = load_abi("BinaryMarket")
    found = []
    for row in ledger.values():
        if not isinstance(row, dict) or "market" not in row:
            continue
        contract = w3.eth.contract(address=Web3.to_checksum_address(row["market"]), abi=market_abi)
        if Web3.to_checksum_address(contract.functions.oracle().call()) != oracle:
            time.sleep(RPC_COURTESY_SLEEP)
            continue
        found.append({
            "market": row["market"], "metricId": row["metricId"], "dayKey": int(row["dayKey"]),
            "resolved": bool(contract.functions.resolved().call()),
            "cancelled": bool(contract.functions.cancelled().call()),
        })
        time.sleep(RPC_COURTESY_SLEEP)
    return found


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--oracle", required=True, help="the GridOracleV2 address")
    parser.add_argument("--deploy-tx", required=True, help="the transaction that deployed it")
    parser.add_argument("--write", action="store_true", help="write shared/addresses.json")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        new_oracle = Web3.to_checksum_address(args.oracle)
        addresses = load_addresses()
        config = load_json(ADDRESSES_PATH)
        w3 = make_web3(os.environ.get("XLAYER_RPC_URL", DEFAULT_RPC_URL))
        current = addresses["oracle"]

        roles = read_new_oracle(w3, new_oracle)
        current_window = int(w3.eth.contract(address=current, abi=load_abi("GridOracle"))
                             .functions.disputeWindow().call())
        if roles["disputeWindow"] != current_window:
            raise PublisherError(
                f"The new oracle's dispute window is {roles['disputeWindow']}s; the current "
                f"one's is {current_window}s. Deploy it with ORACLE_DISPUTE_WINDOW={current_window}.")
        print(f"New oracle {new_oracle}")
        for role in ("owner", "reporter", "guardian"):
            print(f"  {role + ':':10} {roles[role]}")
        print(f"  dispute window: {roles['disputeWindow']}s")

        markets = current_oracle_markets(w3, current)
        publish_ledger = load_json(PUBLISH_LEDGER) if PUBLISH_LEDGER.exists() else {}
        rows = [r for r in publish_ledger.values() if isinstance(r, dict) and "dayKey" in r]
        problems = unsettled(markets, rows)
        if problems:
            print(f"\nNot switching: {len(problems)} thing(s) still in progress on {current}:")
            for line in problems:
                print(f"  - {line}")
            return 1
        day_keys = [m["dayKey"] for m in markets] + [int(r["dayKey"]) for r in rows]
        if not day_keys:
            raise PublisherError("The current oracle has no markets or readings; nothing to retire.")
        last_day_key = max(day_keys)
        print(f"\nRetiring {current}: {len(markets)} markets settled, {len(rows)} readings final, "
              f"last day {last_day_key}.")

        updated = switched_config(config, new_oracle, args.deploy_tx, roles, last_day_key)
        if not args.write:
            print("\nDRY RUN: shared/addresses.json not changed. Run again with --write.")
            return 0
        ADDRESSES_PATH.write_text(json.dumps(updated, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print("\nWrote shared/addresses.json. Next: python build_feed_data.py, then commit both "
              "on a branch (shared/oracle-v2.md, step 5).")
        return 0
    except PublisherError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
