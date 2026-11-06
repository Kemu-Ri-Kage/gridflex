#!/usr/bin/env python3
"""What the daily settle job has to do next, and whether anything needs a
person (daily-settle spec §9C).

Read-only: nothing is signed or sent and no key is loaded. Every chain read
is pinned to one block, and every answer comes from that block plus the
committed files - never from what an earlier run did - so it is always safe
to run again.

It looks at the markets in data/market-ledger.json whose market day falls in
the last LOOKBACK_DAYS, the GridOracle readings they settle on, and the
committed metric files, and reports:

  fetchNeeded           no metric file yet for today's UTC date, or for a
                        closed, unsettled market day
  publish               market days whose trading has closed, whose metric
                        file exists and whose reading is not on chain yet
  publishStart/End      the first and last of those (YYYYMMDD, as publish.py
                        takes them)
  finalize              readings published, not final, dispute window over
  finalizeStart         the earliest of those (YYYYMMDD, for finalize.py)
  secondsToFinalizable  seconds until the next published reading can be
                        finalized: 0 when one already can, null when none waits
  resolve               markets resolve() would accept now
  overdue               closed more than OVERDUE_HOURS ago and not settled
  cancelRisk            unsettled, no reading on chain, and cancel() opens
                        within CANCEL_RISK_HOURS (or is already open)
  unsettleable          closed markets on a daylight-saving changeover day,
                        which never get a metric file (shared/metrics.md)
  fileDrift             a committed file whose value or sourceHash differs
                        from the chain (the 9 Oct symptom)
  outOfRange            a reading outside RANGE_MIN_CENTS..RANGE_MAX_CENTS;
                        the job holds finalizing for a person
  lastMarketDay         the latest market day in the ledger
  ladderRunningOut      no market day after tomorrow
  balances, lowGas      OKB of the reporter, and of the settler when
                        shared/addresses.json names one

Usage:
  python scripts/settle_due.py              # readable report
  python scripts/settle_due.py --check      # exit 3 if any alert holds
  python scripts/settle_due.py --get secondsToFinalizable
  python scripts/settle_due.py --json logs/plan.json

Exit codes: 0 fine, 2 the chain or files couldn't be read, 3 (--check only)
an alert condition holds.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from hexbytes import HexBytes  # noqa: E402
from web3 import Web3  # noqa: E402

import resolve_markets as rm  # noqa: E402
from create_markets import RPC_COURTESY_SLEEP, load_abi, load_addresses  # noqa: E402
from publish import (  # noqa: E402
    DEFAULT_RPC_URL,
    PublisherError,
    load_json,
    make_web3,
    normalize_hash,
)

METRICS_DIR = ROOT / "data" / "metrics"
MARKET_LEDGER = ROOT / "data" / "market-ledger.json"
ADDRESSES_PATH = ROOT / "shared" / "addresses.json"

# The metric the daily refresh fetches and every live market settles on.
DAILY_METRIC = "ERCOT_HBNORTH_DA_AVG"

LOOKBACK_DAYS = 30
OVERDUE_HOURS = 12
CANCEL_RISK_HOURS = 48
# A published value outside this band is held before finalizing: once final
# it can never be corrected, and a market pays out on it.
RANGE_MIN_CENTS = -5_000      # -$50/MWh
RANGE_MAX_CENTS = 100_000     # $1,000/MWh
LOW_GAS_WEI = 5 * 10**15      # 0.005 OKB

ALERT_FIELDS = ("overdue", "cancelRisk", "unsettleable", "fileDrift",
                "outOfRange", "ladderRunningOut", "lowGas")

CENTRAL = ZoneInfo("America/Chicago")


@dataclass
class Market:
    """One market-ledger row plus its settlement state at the pinned block."""
    address: str
    metric_id: str
    day_key: int
    threshold: int
    resolve_after: int
    dispute_window: int     # the market's own: cancel() opens at resolveAfter + this
    resolved: bool
    cancelled: bool


@dataclass
class Reading:
    """A GridOracle reading at the pinned block. `final` is isFinal(), the
    flag resolve() checks."""
    value: int
    source_hash: str
    published_at: int
    final: bool


def day_key(day: date) -> int:
    return int(day.strftime("%Y%m%d"))


def day_of(key: int) -> date:
    return datetime.strptime(str(key), "%Y%m%d").date()


def is_dst_changeover(day: date) -> bool:
    """A Central market day that is 23 or 25 hours long. Its hourly data fails
    the completeness check, so no metric file is ever written for it."""
    start = datetime(day.year, day.month, day.day, tzinfo=CENTRAL)
    nxt = day + timedelta(days=1)
    end = datetime(nxt.year, nxt.month, nxt.day, tzinfo=CENTRAL)
    return end.astimezone(timezone.utc) - start.astimezone(timezone.utc) != timedelta(hours=24)


def plan(markets: list[Market], readings: dict[tuple[str, int], Reading],
         files: dict[tuple[str, int], dict[str, Any]], now: int, oracle_window: int,
         last_market_day: int | None, balances: dict[str, int] | None = None) -> dict[str, Any]:
    """Everything the job and the alerts need, from one consistent snapshot.
    Pure: no chain or file access, so every rule here is unit-tested."""
    today = datetime.fromtimestamp(now, timezone.utc).date()
    unsettled = [m for m in markets if not m.resolved and not m.cancelled]
    closed = [m for m in unsettled if now >= m.resolve_after]
    unsettleable = [m for m in closed if is_dst_changeover(day_of(m.day_key))]
    settleable = [m for m in closed if m not in unsettleable]

    def key(m: Market) -> tuple[str, int]:
        return (m.metric_id, m.day_key)

    missing_today = (not is_dst_changeover(today)
                     and (DAILY_METRIC, day_key(today)) not in files)
    missing_closed = [m for m in settleable if key(m) not in files]

    publish = sorted({key(m) for m in settleable if key(m) not in readings and key(m) in files})

    waiting = {k: r for k, r in readings.items() if r.published_at and not r.final}
    finalize = sorted(k for k, r in waiting.items() if now >= r.published_at + oracle_window)
    seconds = (min(max(0, r.published_at + oracle_window - now) for r in waiting.values())
               if waiting else None)

    resolve = [m.address for m in settleable
               if key(m) in readings and readings[key(m)].final]
    overdue = [m for m in closed if now - m.resolve_after > OVERDUE_HOURS * 3600]
    cancel_risk = [m for m in unsettled
                   if m.dispute_window > 0 and key(m) not in readings
                   and now >= m.resolve_after + m.dispute_window - CANCEL_RISK_HOURS * 3600]

    drift = []
    for k in sorted(set(files) & set(readings)):
        f, r = files[k], readings[k]
        if int(f.get("value", r.value)) != r.value or normalize_hash(f.get("sourceHash")) != r.source_hash:
            drift.append({"metricId": k[0], "dayKey": k[1], "fileValue": f.get("value"),
                          "chainValue": r.value, "fileHash": normalize_hash(f.get("sourceHash")),
                          "chainHash": r.source_hash})
    out_of_range = [{"metricId": k[0], "dayKey": k[1], "value": r.value}
                    for k, r in sorted(readings.items())
                    if not RANGE_MIN_CENTS <= r.value <= RANGE_MAX_CENTS]

    ladder_short = last_market_day is None or last_market_day < day_key(today + timedelta(days=2))
    balances = balances or {}
    low_gas = sorted(label for label, wei in balances.items() if wei < LOW_GAS_WEI)

    def daykeys(keys):
        return sorted({k[1] for k in keys})

    def market_rows(ms):
        return [{"address": m.address, "metricId": m.metric_id, "dayKey": m.day_key,
                 "threshold": m.threshold, "resolveAfter": m.resolve_after,
                 "cancellableAt": m.resolve_after + m.dispute_window} for m in ms]

    result: dict[str, Any] = {
        "chainTime": now,
        "today": day_key(today),
        "fetchNeeded": bool(missing_today or missing_closed),
        "publish": [{"metricId": k[0], "dayKey": k[1]} for k in publish],
        "publishStart": daykeys(publish)[0] if publish else None,
        "publishEnd": daykeys(publish)[-1] if publish else None,
        "finalize": [{"metricId": k[0], "dayKey": k[1]} for k in finalize],
        "finalizeStart": daykeys(finalize)[0] if finalize else None,
        "secondsToFinalizable": seconds,
        "resolve": resolve,
        "overdue": market_rows(overdue),
        "cancelRisk": market_rows(cancel_risk),
        "unsettleable": market_rows(unsettleable),
        "fileDrift": drift,
        "outOfRange": out_of_range,
        "lastMarketDay": last_market_day,
        "ladderRunningOut": ladder_short,
        "balances": {label: str(wei) for label, wei in balances.items()},
        "lowGas": low_gas,
    }
    result["alerts"] = [name for name in ALERT_FIELDS if result[name]]
    return result


# ---------------------------------------------------------------- reading state

def load_files(keys: set[tuple[str, int]]) -> dict[tuple[str, int], dict[str, Any]]:
    """The committed metric file for each (metricId, dayKey), when it exists."""
    found = {}
    for metric_id, key in keys:
        path = METRICS_DIR / f"{metric_id}__{day_of(key).isoformat()}.json"
        if path.exists():
            record = load_json(path)
            found[(metric_id, key)] = {"value": record.get("value"),
                                       "sourceHash": record.get("sourceHash")}
    return found


def gather(w3: Web3, block: int, now: int) -> dict[str, Any]:
    """Read every input plan() needs, pinned to `block`."""
    addresses = load_addresses()
    config = load_json(ADDRESSES_PATH)
    ledger = load_json(MARKET_LEDGER) if MARKET_LEDGER.exists() else {}
    rows = [row for row in ledger.values() if isinstance(row, dict) and "market" in row]
    today = datetime.fromtimestamp(now, timezone.utc).date()
    cutoff = day_key(today - timedelta(days=LOOKBACK_DAYS))

    oracle = w3.eth.contract(address=addresses["oracle"], abi=load_abi("GridOracle"))
    market_abi = load_abi("BinaryMarket")
    oracle_window = int(rm.pinned_call(oracle.functions.disputeWindow(), block))

    markets = []
    for row in rows:
        if int(row["dayKey"]) < cutoff:
            continue
        contract = w3.eth.contract(address=Web3.to_checksum_address(row["market"]), abi=market_abi)
        markets.append(Market(
            address=Web3.to_checksum_address(row["market"]),
            metric_id=row["metricId"],
            day_key=int(row["dayKey"]),
            threshold=int(row["threshold"]),
            resolve_after=int(row["resolveAfter"]),
            dispute_window=int(row["disputeWindow"]),
            resolved=bool(rm.pinned_call(contract.functions.resolved(), block)),
            cancelled=bool(rm.pinned_call(contract.functions.cancelled(), block)),
        ))
        time.sleep(RPC_COURTESY_SLEEP)

    # Every market day, plus every daily-metric day in the window, so a
    # reading published for a day without markets still gets finalized.
    keys = {(m.metric_id, m.day_key) for m in markets}
    keys |= {(DAILY_METRIC, day_key(today - timedelta(days=i))) for i in range(LOOKBACK_DAYS + 1)}
    files = load_files(keys)
    readings = {}
    for metric_id, key in sorted(keys):
        if (metric_id, key) not in files and not any(
                (m.metric_id, m.day_key) == (metric_id, key) for m in markets):
            continue
        metric_hash = Web3.keccak(text=metric_id)
        raw = rm.pinned_call(oracle.functions.getReading(metric_hash, key), block)
        time.sleep(RPC_COURTESY_SLEEP)
        if int(raw[6]) == 0:
            continue
        readings[(metric_id, key)] = Reading(
            value=int(raw[4]),
            source_hash=normalize_hash(HexBytes(raw[5]).hex()),
            published_at=int(raw[6]),
            final=bool(rm.pinned_call(oracle.functions.isFinal(metric_hash, key), block)),
        )
        time.sleep(RPC_COURTESY_SLEEP)

    balances = {}
    for label in ("reporter", "settler"):
        if config.get(label):
            balances[label] = int(w3.eth.get_balance(
                Web3.to_checksum_address(config[label]), block_identifier=block))

    daily = [int(r["dayKey"]) for r in rows if r.get("metricId") == DAILY_METRIC]
    return {"markets": markets, "readings": readings, "files": files,
            "oracle_window": oracle_window, "last_market_day": max(daily) if daily else None,
            "balances": balances}


# ---------------------------------------------------------------- output

def field_text(value: Any) -> str:
    """One field as plain text for the shell: no jq needed."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list):
        return " ".join(str(item.get("dayKey", item)) if isinstance(item, dict) else str(item)
                        for item in value)
    return str(value)


def render(result: dict[str, Any]) -> str:
    def days(items):
        return ", ".join(str(i["dayKey"]) for i in items) or "none"

    when = datetime.fromtimestamp(result["chainTime"], timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        f"GRIDFLEX settle plan at chain time {when}",
        f"  fetch needed:      {field_text(result['fetchNeeded'])}",
        f"  to publish:        {days(result['publish'])}",
        f"  to finalize now:   {days(result['finalize'])}",
        f"  next finalizable:  {result['secondsToFinalizable'] if result['secondsToFinalizable'] is not None else '-'} s",
        f"  to resolve:        {len(result['resolve'])} market(s)",
        f"  last market day:   {result['lastMarketDay'] or 'none'}",
    ]
    for label, wei in result["balances"].items():
        lines.append(f"  {label} balance:  {Web3.from_wei(int(wei), 'ether'):.4f} OKB")
    if result["alerts"]:
        lines.append("ALERTS:")
        labels = {
            "overdue": f"{len(result['overdue'])} market(s) closed over {OVERDUE_HOURS}h ago and not settled: "
                       f"{days(result['overdue'])}",
            "cancelRisk": f"{len(result['cancelRisk'])} market(s) with no reading and cancel() open or "
                          f"within {CANCEL_RISK_HOURS}h: {days(result['cancelRisk'])}",
            "unsettleable": f"daylight-saving changeover day(s) can't settle: {days(result['unsettleable'])}",
            "fileDrift": f"committed file differs from the chain: {days(result['fileDrift'])}",
            "outOfRange": f"reading outside -$50..$1,000/MWh, finalizing held: {days(result['outOfRange'])}",
            "ladderRunningOut": f"no market day after tomorrow (last: {result['lastMarketDay'] or 'none'})",
            "lowGas": f"below 0.005 OKB: {', '.join(result['lowGas'])}",
        }
        lines += [f"  - {labels[name]}" for name in result["alerts"]]
    else:
        lines.append("No alerts.")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="exit 3 if any alert condition holds")
    parser.add_argument("--get", metavar="FIELD", help="print one field and exit")
    parser.add_argument("--json", metavar="PATH", help="also write the whole plan as JSON")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        w3 = make_web3(os.environ.get("XLAYER_RPC_URL", DEFAULT_RPC_URL))
        rm.chain_guard(w3)
        block, now = rm.chain_snapshot(w3)
        state = gather(w3, block, now)
    except (PublisherError, OSError, ValueError, KeyError) as exc:
        print(f"settle_due: could not read the chain or files: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # RPC errors arrive as many types
        print(f"settle_due: could not read the chain ({type(exc).__name__}): {exc}", file=sys.stderr)
        return 2
    result = plan(state["markets"], state["readings"], state["files"], now,
                  state["oracle_window"], state["last_market_day"], state["balances"])
    if args.json:
        path = Path(args.json)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    if args.get:
        if args.get not in result:
            print(f"settle_due: no field {args.get!r}; fields: {', '.join(result)}", file=sys.stderr)
            return 2
        print(field_text(result[args.get]))
        return 0
    print(render(result))
    return 3 if args.check and result["alerts"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
