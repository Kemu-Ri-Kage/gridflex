#!/usr/bin/env python3
"""Read-only current-state report: what the chain says, and whether the
committed files agree with it.

Every read is pinned to one block. Nothing is signed or sent, and no key is
needed. The report is written as Markdown (default docs/ops/state-<date>.md)
and the exit code is 1 when any discrepancy between the chain and the
committed files is found, so the script works as a gate before any
state-changing run (Revision 2 plan, Stage 0.2).

What it compares, in order:

1. Every market listed by the current MarketFactory and by every factory in
   shared/addresses.json's legacyDeployments, against shared/addresses.json
   "markets" and data/market-ledger.json: a market on chain must have a
   record in both files, every record must be on chain, and the recorded
   metricId/dayKey/threshold/resolveAfter/disputeWindow must match the
   immutables the market reports.
2. Every (metricId, dayKey) a market settles on, plus every
   data/publish-ledger.json row, against GridOracle.getReading(): a reading
   on chain must have a ledger row with the same value, and a ledger row
   must be on chain; a ledger row's status must not claim more than the
   chain shows.
3. Each market's settlement status at the pinned block, using the same
   classification resolve_markets.py uses, plus when cancel() opens for it
   (resolveAfter + disputeWindow), because an unread market can be
   cancelled by anyone from that moment.
4. OKB balances of the deployer/reporter and, when FINALIZER_ADDRESS is set,
   the finalizer wallet. No key is loaded.

Usage:
    python3 scripts/state_report.py                  # writes docs/ops/state-YYYY-MM-DD.md
    python3 scripts/state_report.py --out report.md  # elsewhere
    python3 scripts/state_report.py --quiet          # summary and exit code only
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from hexbytes import HexBytes  # noqa: E402
from web3 import Web3  # noqa: E402

from create_markets import (  # noqa: E402
    ADDRESSES_PATH,
    MARKET_LEDGER_PATH,
    RPC_COURTESY_SLEEP,
    format_close,
    load_abi,
    load_addresses,
    load_market_ledger,
)
from publish import (  # noqa: E402
    DEFAULT_RPC_URL,
    LEDGER_PATH,
    PublisherError,
    load_json,
    load_ledger,
    make_web3,
)
from resolve_markets import (  # noqa: E402
    METRIC_NAMES,
    STATUS_TEXT,
    MarketState,
    chain_guard,
    chain_snapshot,
    classify,
    format_value,
    pinned_call,
    read_market,
)

DEFAULT_OUT_DIR = ROOT / "docs" / "ops"


@dataclass
class Discrepancy:
    where: str
    what: str


@dataclass
class ChainReading:
    value: int
    source_hash: str
    published_at: int
    finalized: bool


@dataclass
class Report:
    block_number: int
    chain_time: int
    rpc_url: str
    factories: list[dict[str, Any]] = field(default_factory=list)
    markets: list[dict[str, Any]] = field(default_factory=list)
    readings: dict[str, ChainReading | None] = field(default_factory=dict)
    balances: dict[str, int] = field(default_factory=dict)
    discrepancies: list[Discrepancy] = field(default_factory=list)

    def flag(self, where: str, what: str) -> None:
        self.discrepancies.append(Discrepancy(where, what))


def legacy_factories(config: dict[str, Any]) -> list[dict[str, Any]]:
    """Every superseded MarketFactory recorded in shared/addresses.json."""
    legacy = config.get("legacyDeployments", {}).get("MarketFactory", [])
    out = []
    for entry in legacy:
        if not isinstance(entry, dict) or "address" not in entry:
            raise PublisherError(f"{ADDRESSES_PATH}: malformed legacyDeployments.MarketFactory entry {entry!r}")
        out.append({
            "address": Web3.to_checksum_address(entry["address"]),
            "status": entry.get("status", "superseded"),
            "transaction": entry.get("transaction"),
        })
    return out


def read_reading(oracle_contract, metric_hash: bytes, day_key: int, block_number: int) -> ChainReading | None:
    raw = pinned_call(oracle_contract.functions.getReading(metric_hash, day_key), block_number)
    if int(raw[6]) == 0:
        return None
    return ChainReading(
        value=int(raw[4]),
        source_hash=HexBytes(raw[5]).hex().removeprefix("0x"),
        published_at=int(raw[6]),
        finalized=bool(raw[7]),
    )


def reading_key(metric_name: str, day_key: int) -> str:
    return f"{metric_name}:{day_key}"


def collect(w3: Web3, config: dict[str, Any], addresses: dict[str, Any],
            market_ledger: dict[str, dict[str, Any]], publish_ledger: dict[str, dict[str, Any]],
            rpc_url: str) -> Report:
    chain_guard(w3)
    block_number, chain_time = chain_snapshot(w3)
    report = Report(block_number=block_number, chain_time=chain_time, rpc_url=rpc_url)

    binary_market_abi = load_abi("BinaryMarket")
    factory_abi = load_abi("MarketFactory")
    oracle = w3.eth.contract(address=addresses["oracle"], abi=load_abi("GridOracle"))

    for name, address in (("GridOracle", addresses["oracle"]), ("MarketFactory", addresses["factory"]),
                          ("MockUSDT", addresses["collateral"])):
        code = w3.eth.get_code(address, block_identifier=block_number)
        if not code or code == HexBytes("0x"):
            report.flag(name, f"no bytecode at {address}")

    # 1. Markets: current factory first, then every legacy factory.
    factories = [{"address": addresses["factory"], "status": "current", "transaction":
                  config.get("transactions", {}).get("MarketFactory")}] + legacy_factories(config)
    file_markets = {Web3.to_checksum_address(m["market"]): m for m in config.get("markets", [])}
    ledger_by_address = {Web3.to_checksum_address(e["market"]): (k, e) for k, e in market_ledger.items()
                         if isinstance(e, dict) and e.get("market")}
    seen_on_chain: set[str] = set()

    for factory in factories:
        contract = w3.eth.contract(address=factory["address"], abi=factory_abi)
        listed = list(pinned_call(contract.functions.getMarkets(), block_number))
        factory["marketCount"] = len(listed)
        report.factories.append(factory)
        for address in listed:
            address = Web3.to_checksum_address(address)
            seen_on_chain.add(address)
            state: MarketState = read_market(w3, oracle, address, binary_market_abi, block_number)
            market = w3.eth.contract(address=address, abi=binary_market_abi)
            dispute_window = int(pinned_call(market.functions.disputeWindow(), block_number))
            status = classify(state, chain_time)
            record = {
                "factory": factory["address"],
                "factoryStatus": factory["status"],
                "address": address,
                "metric": state.metric_name,
                "dayKey": state.day_key,
                "threshold": state.threshold,
                "resolveAfter": state.resolve_after,
                "disputeWindow": dispute_window,
                "cancellableAt": state.resolve_after + dispute_window,
                "status": status,
                "resolved": state.resolved,
                "cancelled": state.cancelled,
                "yesWon": state.yes_won,
                "readingValue": state.reading_value,
                "readingFinal": state.reading_final,
                "inAddressesJson": address in file_markets,
                "inMarketLedger": address in ledger_by_address,
            }
            report.markets.append(record)
            key = reading_key(state.metric_name, state.day_key)
            if key not in report.readings:
                report.readings[key] = read_reading(oracle, HexBytes("0x" + state.metric_hash), state.day_key, block_number)

            if address not in file_markets:
                report.flag(address, "market on chain but missing from shared/addresses.json markets[]")
            else:
                _compare_record(report, address, "shared/addresses.json", file_markets[address], record)
            if address not in ledger_by_address:
                report.flag(address, "market on chain but missing from data/market-ledger.json")
            else:
                _compare_record(report, address, "data/market-ledger.json", ledger_by_address[address][1], record)
            time.sleep(RPC_COURTESY_SLEEP)

    for address in file_markets:
        if address not in seen_on_chain:
            report.flag(address, "listed in shared/addresses.json but not created by any known factory")
    for address, (key, _entry) in ledger_by_address.items():
        if address not in seen_on_chain:
            report.flag(address, f"data/market-ledger.json entry {key!r} not created by any known factory")

    # 2. Readings: every publish-ledger row, plus the market days read above.
    for key, entry in publish_ledger.items():
        metric_name = entry.get("metricId")
        day_key = int(entry.get("dayKey"))
        rkey = reading_key(metric_name, day_key)
        if rkey not in report.readings:
            report.readings[rkey] = read_reading(oracle, Web3.keccak(text=metric_name), day_key, block_number)
            time.sleep(RPC_COURTESY_SLEEP)
        chain = report.readings[rkey]
        if chain is None:
            if entry.get("txHash"):
                report.flag(rkey, "publish-ledger row has a txHash but nothing is published on chain")
            continue
        if int(entry.get("value")) != chain.value:
            report.flag(rkey, f"publish-ledger value {entry.get('value')} != chain value {chain.value}")
        ledger_hash = str(entry.get("sourceHash", "")).lower().removeprefix("0x")
        if ledger_hash != chain.source_hash:
            report.flag(rkey, "publish-ledger sourceHash differs from chain sourceHash")
        if entry.get("status") == "finalized" and not chain.finalized:
            report.flag(rkey, "publish-ledger says finalized but chain says not finalized")
        if entry.get("status") == "confirmed" and chain.finalized:
            report.flag(rkey, "chain says finalized but publish-ledger still says confirmed (run finalize.py dry run to refresh)")
    for rkey, chain in report.readings.items():
        if chain is not None and rkey not in publish_ledger:
            report.flag(rkey, "reading on chain with no data/publish-ledger.json row")

    # 4. Balances (no key loaded).
    for label, address in (("deployer", config.get("deployer")), ("reporter", config.get("reporter")),
                           ("finalizer", os.environ.get("FINALIZER_ADDRESS"))):
        if address:
            report.balances[label] = int(w3.eth.get_balance(Web3.to_checksum_address(address),
                                                            block_identifier=block_number))
    return report


def _compare_record(report: Report, address: str, source: str, record: dict[str, Any], chain: dict[str, Any]) -> None:
    checks = (
        ("metricId", record.get("metricId"), chain["metric"]),
        ("dayKey", record.get("dayKey"), chain["dayKey"]),
        ("threshold", record.get("threshold"), chain["threshold"]),
        ("resolveAfter", record.get("resolveAfter"), chain["resolveAfter"]),
        ("disputeWindow", record.get("disputeWindow"), chain["disputeWindow"]),
    )
    for name, recorded, actual in checks:
        if recorded is None:
            continue
        if str(recorded) != str(actual):
            report.flag(address, f"{source} {name}={recorded!r} but chain says {actual!r}")


def fmt_time(epoch: int) -> str:
    return format_close(epoch)


def render(report: Report, generated_at: datetime) -> str:
    lines: list[str] = []
    lines.append(f"# GRIDFLEX current state — {generated_at:%Y-%m-%d %H:%M} UTC")
    lines.append("")
    lines.append(f"Read-only snapshot at block `{report.block_number}`, chain time {fmt_time(report.chain_time)}, "
                 f"via `{report.rpc_url}`. Generated by `scripts/state_report.py`; nothing was sent.")
    lines.append("")
    lines.append("## Verdict")
    lines.append("")
    if report.discrepancies:
        lines.append(f"**{len(report.discrepancies)} discrepancy(ies)** between the chain and the committed files:")
        lines.append("")
        for d in report.discrepancies:
            lines.append(f"- `{d.where}`: {d.what}")
    else:
        lines.append("**No discrepancies.** The committed files agree with the chain at this block.")
    lines.append("")

    lines.append("## Factories")
    lines.append("")
    lines.append("| Factory | Status | Markets | Deployment tx |")
    lines.append("|---|---|---|---|")
    for f in report.factories:
        lines.append(f"| `{f['address']}` | {f['status']} | {f['marketCount']} | `{f.get('transaction') or '—'}` |")
    lines.append("")

    lines.append("## Markets")
    lines.append("")
    lines.append("| Market | Metric | dayKey | Strike | Trading close | Status | Reading | cancel() opens | In files |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for m in sorted(report.markets, key=lambda r: (r["dayKey"], r["threshold"])):
        if m["resolved"]:
            status = f"resolved {'YES' if m['yesWon'] else 'NO'}"
        elif m["cancelled"]:
            status = "cancelled"
        else:
            status = STATUS_TEXT[m["status"]].replace("SKIP ", "")
        if m["readingValue"] is None:
            reading = "not published"
        else:
            reading = f"{format_value(m['readingValue'], m['metric'])} ({'final' if m['readingFinal'] else 'not final'})"
        if m["resolved"] or m["cancelled"]:
            cancel = "settled"
        elif m["readingValue"] is not None:
            cancel = "blocked by reading"
        elif report.chain_time >= m["cancellableAt"]:
            cancel = "OPEN NOW"
        else:
            cancel = fmt_time(m["cancellableAt"])
        files = ("addresses " if m["inAddressesJson"] else "NO-addresses ") + ("ledger" if m["inMarketLedger"] else "NO-ledger")
        legacy = "" if m["factoryStatus"] == "current" else f" ({m['factoryStatus']} factory)"
        lines.append(
            f"| `{m['address'][:10]}…{m['address'][-4:]}`{legacy} | {m['metric']} | {m['dayKey']} | "
            f"{format_value(m['threshold'], m['metric'])} | {fmt_time(m['resolveAfter'])} | {status} | {reading} | {cancel} | {files} |"
        )
    lines.append("")
    unread = [m for m in report.markets if not (m["resolved"] or m["cancelled"]) and m["readingValue"] is None]
    exposed = [m for m in unread if report.chain_time >= m["cancellableAt"]]
    lines.append(f"Unsettled markets without a reading: **{len(unread)}**, of which **{len(exposed)}** can be cancelled by "
                 "anyone right now (publishing their reading blocks `cancel()`).")
    lines.append("")

    lines.append("## Oracle readings referenced")
    lines.append("")
    lines.append("| Reading | On chain | Value | Published at | Final |")
    lines.append("|---|---|---|---|---|")
    for key in sorted(report.readings):
        chain = report.readings[key]
        metric = key.split(":")[0]
        if chain is None:
            lines.append(f"| `{key}` | no | — | — | — |")
        else:
            lines.append(f"| `{key}` | yes | {format_value(chain.value, metric)} | {fmt_time(chain.published_at)} | "
                         f"{'yes' if chain.finalized else 'no'} |")
    lines.append("")

    lines.append("## Balances")
    lines.append("")
    for label, wei in report.balances.items():
        lines.append(f"- {label}: {Web3.from_wei(wei, 'ether'):.6f} OKB")
    if "finalizer" not in report.balances:
        lines.append("- finalizer: not checked (set FINALIZER_ADDRESS to include it)")
    lines.append("")
    return "\n".join(lines) + "\n"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", help="Markdown report path (default docs/ops/state-<date>.md)")
    parser.add_argument("--quiet", action="store_true", help="print only the verdict")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    rpc_url = os.environ.get("XLAYER_RPC_URL", DEFAULT_RPC_URL)
    try:
        config = load_json(ADDRESSES_PATH)
        addresses = load_addresses()
        market_ledger = load_market_ledger()
        publish_ledger = load_ledger()
        w3 = make_web3(rpc_url)
        report = collect(w3, config, addresses, market_ledger, publish_ledger, rpc_url)
    except PublisherError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    generated_at = datetime.now(timezone.utc)
    out = Path(args.out) if args.out else DEFAULT_OUT_DIR / f"state-{generated_at:%Y-%m-%d}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    text = render(report, generated_at)
    out.write_text(text, encoding="utf-8")
    if not args.quiet:
        print(text, end="")
    print(f"Report written to {out}")
    print(f"Discrepancies: {len(report.discrepancies)}")
    return 1 if report.discrepancies else 0


if __name__ == "__main__":
    sys.exit(main())
