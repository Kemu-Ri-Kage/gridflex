#!/usr/bin/env python3
"""Resolve every GRIDFLEX market whose trading has closed and whose oracle
reading is final.

Dry-run is the default: it lists every market MarketFactory.getMarkets()
returns, with its reading and the side that would win, and sends nothing.
Live mode (--live) requires a finalizer key, a passing preflight, and an
interactive ``yes`` confirmation.

BinaryMarket.resolve() is permissionless (contracts/src/BinaryMarket.sol:
`function resolve() external`, no caller check - it only requires the
market to be unsettled, block.timestamp >= resolveAfter, and
GridOracle.isFinal(metricId, dayKey)), so this reuses finalize.py's
finalizer-key convention (FINALIZER_PRIVATE_KEY / FINALIZER_KEYSTORE_PATH),
as create_markets.py does. The key is never printed or logged; only the
signer's address is.

Each market is judged against the same three conditions resolve() checks,
in the same order, read live from the chain - never from the local ledger -
and every read pinned to one block, so resolved() and yesWon() can't come
from different points in time:

- already settled: resolved() or cancelled() is true - skipped;
- not closed: the latest block's timestamp is before resolveAfter (the
  clock resolve() itself uses, not this machine's) - skipped;
- no final reading: nothing published for (metricId, dayKey), or published
  but GridOracle.isFinal() is still false - skipped.

Everything else is a candidate. YES wins when the reading is strictly above
the strike (resolve(): `yesWon = reading.value > threshold`). After each
live resolve the outcome is taken from the Resolved(yesWon, oracleValue)
event in the transaction's own receipt - never from a separate yesWon()
call, which the public RPC can serve from a node that hasn't reached the
resolve block yet and so answers with the pre-resolution default, false.
The event's outcome and value are then checked against the reading.

A summary is printed on every exit path: dry run, nothing to do, cancelled
confirmation, success, error, or Ctrl-C.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from hexbytes import HexBytes
from web3 import Web3
from web3.logs import DISCARD

from create_markets import (
    RPC_COURTESY_SLEEP,
    format_close,
    load_abi,
    load_addresses,
    send_tx,
)
from finalize import load_finalizer_account
from publish import (
    DEFAULT_RPC_URL,
    EXPECTED_CHAIN_ID,
    EXPECTED_METRICS,
    LOGS_DIR,
    PublisherError,
    make_web3,
)

# The oracle stores keccak256(metricId name); map it back for display.
METRIC_NAMES = {Web3.keccak(text=name).hex().removeprefix("0x"): name for name in EXPECTED_METRICS}

PINNED_CALL_ATTEMPTS = 5
PINNED_CALL_DELAY_SECONDS = 1.0

# Signed spreads show a sign; price levels don't (shared/metrics.md).
SIGNED_METRICS = {"ERCOT_WEST_NORTH_DA_BASIS"}

STATUS_CANDIDATE = "candidate"
STATUS_RESOLVED = "already_resolved"
STATUS_CANCELLED = "cancelled"
STATUS_NOT_CLOSED = "not_closed"
STATUS_NOT_PUBLISHED = "reading_not_published"
STATUS_NOT_FINAL = "reading_not_final"

STATUS_TEXT = {
    STATUS_CANDIDATE: "CANDIDATE",
    STATUS_RESOLVED: "SKIP already resolved",
    STATUS_CANCELLED: "SKIP cancelled",
    STATUS_NOT_CLOSED: "SKIP trading not closed",
    STATUS_NOT_PUBLISHED: "SKIP no reading published",
    STATUS_NOT_FINAL: "SKIP reading not final",
}


@dataclass(frozen=True)
class MarketState:
    address: str
    metric_hash: str
    day_key: int
    threshold: int
    resolve_after: int
    resolved: bool
    cancelled: bool
    yes_won: bool
    # None when nothing is published for (metricId, dayKey).
    reading_value: int | None
    reading_final: bool

    @property
    def metric_name(self) -> str:
        return METRIC_NAMES.get(self.metric_hash, "0x" + self.metric_hash)


@dataclass
class Summary:
    mode: str = "dry run"
    listed: int = 0
    statuses: dict[str, int] = field(default_factory=dict)
    resolved: list[dict[str, Any]] = field(default_factory=list)
    raced: list[str] = field(default_factory=list)
    error: str | None = None
    started: float = field(default_factory=time.monotonic)


def classify(state: MarketState, chain_now: int) -> str:
    """resolve()'s own checks, in its order."""
    if state.resolved:
        return STATUS_RESOLVED
    if state.cancelled:
        return STATUS_CANCELLED
    if chain_now < state.resolve_after:
        return STATUS_NOT_CLOSED
    if state.reading_value is None:
        return STATUS_NOT_PUBLISHED
    if not state.reading_final:
        return STATUS_NOT_FINAL
    return STATUS_CANDIDATE


def yes_would_win(reading_value: int, threshold: int) -> bool:
    """BinaryMarket.resolve(): yesWon = reading.value > threshold."""
    return reading_value > threshold


def format_value(cents: int, metric_name: str) -> str:
    dollars = abs(cents) / 100
    sign = "-" if cents < 0 else ("+" if cents > 0 and metric_name in SIGNED_METRICS else "")
    return f"{sign}${dollars:,.2f}/MWh"


def pinned_call(function, block_number: int):
    """One view call at a fixed block, so every read in a run sees the same
    chain state - never resolved() from one block and yesWon() from an older
    one. A node behind the pinned block can reject it; that is retried
    briefly like create_markets' empty-return lag."""
    last_exc: Exception | None = None
    for attempt in range(PINNED_CALL_ATTEMPTS):
        try:
            return function.call(block_identifier=block_number)
        except Exception as exc:  # the node lagging behind block_number
            last_exc = exc
            if attempt < PINNED_CALL_ATTEMPTS - 1:
                time.sleep(PINNED_CALL_DELAY_SECONDS)
    assert last_exc is not None
    raise last_exc


def read_market(w3: Web3, oracle_contract, address: str, binary_market_abi: Any,
                block_number: int) -> MarketState:
    market = w3.eth.contract(address=address, abi=binary_market_abi)

    def read(name: str):
        return pinned_call(getattr(market.functions, name)(), block_number)

    metric_hash = HexBytes(read("metricId"))
    day_key = int(read("dayKey"))
    raw = pinned_call(oracle_contract.functions.getReading(metric_hash, day_key), block_number)
    published = int(raw[6]) != 0
    return MarketState(
        address=Web3.to_checksum_address(address),
        metric_hash=metric_hash.hex().removeprefix("0x"),
        day_key=day_key,
        threshold=int(read("threshold")),
        resolve_after=int(read("resolveAfter")),
        resolved=bool(read("resolved")),
        cancelled=bool(read("cancelled")),
        yes_won=bool(read("yesWon")),
        reading_value=int(raw[4]) if published else None,
        # The flag resolve() checks, not getReading's copy of it.
        reading_final=bool(pinned_call(oracle_contract.functions.isFinal(metric_hash, day_key), block_number))
        if published else False,
    )


def list_market_states(w3: Web3, addresses: dict[str, Any], block_number: int) -> list[MarketState]:
    """Every market MarketFactory has created, all read at block_number."""
    binary_market_abi = load_abi("BinaryMarket")
    factory = w3.eth.contract(address=addresses["factory"], abi=load_abi("MarketFactory"))
    oracle = w3.eth.contract(address=addresses["oracle"], abi=load_abi("GridOracle"))
    states = []
    for address in pinned_call(factory.functions.getMarkets(), block_number):
        states.append(read_market(w3, oracle, address, binary_market_abi, block_number))
        time.sleep(RPC_COURTESY_SLEEP)
    return states


def chain_guard(w3: Web3) -> int:
    try:
        chain_id = int(w3.eth.chain_id)
    except Exception as exc:
        raise PublisherError(f"RPC chain ID check failed: {type(exc).__name__}") from exc
    if chain_id != EXPECTED_CHAIN_ID:
        raise PublisherError(f"Wrong chain: got {chain_id}, expected {EXPECTED_CHAIN_ID}.")
    return chain_id


def chain_snapshot(w3: Web3) -> tuple[int, int]:
    """(number, timestamp) of the latest block: the one block every read in
    this run is pinned to, and the clock resolve() itself is judged by."""
    block = w3.eth.get_block("latest")
    return int(block["number"]), int(block["timestamp"])


def preflight(w3: Web3, addresses: dict[str, Any], account) -> tuple[int, int]:
    chain_id = chain_guard(w3)
    try:
        for name, address in (("GridOracle", addresses["oracle"]), ("MarketFactory", addresses["factory"])):
            code = w3.eth.get_code(address)
            if not code or code == HexBytes("0x"):
                raise PublisherError(f"No contract bytecode at {name} address {address}.")
        balance = w3.eth.get_balance(account.address)
    except PublisherError:
        raise
    except Exception as exc:
        raise PublisherError(f"RPC preflight failed: {type(exc).__name__}") from exc
    return chain_id, balance


def describe(state: MarketState, status: str) -> list[str]:
    metric = state.metric_name
    lines = [
        f"{state.address}  {STATUS_TEXT[status]}",
        f"    {metric} dayKey {state.day_key}, strike {format_value(state.threshold, metric)}",
        f"    trading close {format_close(state.resolve_after)}",
    ]
    if state.resolved:
        lines.append(f"    outcome on chain: {'YES' if state.yes_won else 'NO'}")
    elif state.reading_value is None:
        lines.append("    reading: not published")
    else:
        value = format_value(state.reading_value, metric)
        final = "final" if state.reading_final else "not final"
        lines.append(f"    reading: {value} ({final})")
        yes = yes_would_win(state.reading_value, state.threshold)
        relation = "above" if yes else "at or below"
        lines.append(f"    would win: {'YES' if yes else 'NO'} ({value} is {relation} the strike)")
    return lines


def resolved_event(market_contract, receipt) -> tuple[bool, int]:
    """(yesWon, oracleValue) from the market's Resolved event in `receipt`.

    The receipt is the mined block's own record, so this can't be stale the
    way a follow-up eth_call can. Exactly one Resolved event from this
    market is expected; anything else stops the run.
    """
    events = [
        event for event in market_contract.events.Resolved().process_receipt(receipt, errors=DISCARD)
        if Web3.to_checksum_address(event["address"]) == market_contract.address
    ]
    if len(events) != 1:
        raise PublisherError(
            f"{market_contract.address}: expected one Resolved event in the receipt, found {len(events)}."
        )
    args = events[0]["args"]
    return bool(args["yesWon"]), int(args["oracleValue"])


def resolve_market(w3: Web3, account, market_address: str, log_path) -> tuple[str, int, bool, int]:
    """Send resolve(); return (tx hash, gas cost in wei, yesWon, oracleValue),
    the last two from the receipt's Resolved event."""
    market = w3.eth.contract(address=market_address, abi=load_abi("BinaryMarket"))
    receipt, gas_cost = send_tx(w3, account, market.functions.resolve(), f"resolve {market_address}", log_path)
    tx_hash = "0x" + HexBytes(receipt.transactionHash).hex().removeprefix("0x")
    yes_won, oracle_value = resolved_event(market, receipt)
    return tx_hash, gas_cost, yes_won, oracle_value


def still_unsettled(w3: Web3, market_address: str) -> bool:
    market = w3.eth.contract(address=market_address, abi=load_abi("BinaryMarket"))
    return not (market.functions.resolved().call() or market.functions.cancelled().call())


def print_summary(summary: Summary) -> None:
    elapsed = int(time.monotonic() - summary.started)
    counts = summary.statuses
    gas = sum(record["gasCost"] for record in summary.resolved)
    print("\nGRIDFLEX resolve_markets summary")
    print(f"  Mode:                           {summary.mode}")
    print(f"  Markets listed by factory:      {summary.listed}")
    print(f"  Candidates:                     {counts.get(STATUS_CANDIDATE, 0)}")
    print(f"  Resolved this run:              {len(summary.resolved)}")
    print(f"  Resolved by someone else first: {len(summary.raced)}")
    print(f"  Already resolved (skip):        {counts.get(STATUS_RESOLVED, 0)}")
    print(f"  Cancelled (skip):               {counts.get(STATUS_CANCELLED, 0)}")
    print(f"  Trading not closed (skip):      {counts.get(STATUS_NOT_CLOSED, 0)}")
    print(f"  No reading published (skip):    {counts.get(STATUS_NOT_PUBLISHED, 0)}")
    print(f"  Reading not final (skip):       {counts.get(STATUS_NOT_FINAL, 0)}")
    print(f"  Wall-clock time:                {elapsed // 60:02d}:{elapsed % 60:02d}")
    print(f"  Total gas spent:                {Web3.from_wei(gas, 'ether'):.6f} OKB")
    for record in summary.resolved:
        print(f"  RESOLVED {record['market']} -> {record['outcome']}  tx {record['txHash']}")
    for address in summary.raced:
        print(f"  RACED    {address} (already settled when its turn came; nothing sent)")
    if summary.error:
        print(f"  Stopped early:                  {summary.error}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--live", action="store_true", help="send resolve() transactions (asks first)")
    parser.add_argument(
        "--market", action="append", metavar="ADDRESS",
        help="only consider this market address (repeatable); default is every listed market",
    )
    return parser


def run(args: argparse.Namespace, summary: Summary) -> int:
    addresses = load_addresses()
    w3 = make_web3(os.environ.get("XLAYER_RPC_URL", DEFAULT_RPC_URL))
    chain_guard(w3)

    block_number, now = chain_snapshot(w3)
    states = list_market_states(w3, addresses, block_number)
    summary.listed = len(states)
    if args.market:
        wanted = {Web3.to_checksum_address(a) for a in args.market}
        unknown = wanted - {s.address for s in states}
        if unknown:
            raise PublisherError(f"--market {sorted(unknown)}: not listed by MarketFactory {addresses['factory']}.")
        states = [s for s in states if s.address in wanted]

    print(f"GRIDFLEX resolve_markets - {len(states)} market(s) at block {block_number}, "
          f"chain time {format_close(now)}\n")
    candidates = []
    for state in states:
        status = classify(state, now)
        summary.statuses[status] = summary.statuses.get(status, 0) + 1
        if status == STATUS_CANDIDATE:
            candidates.append(state)
        print("\n".join(describe(state, status)))
        print()

    if not args.live:
        print("DRY RUN ONLY - no transactions were sent.")
        return 0
    summary.mode = "live"
    if not candidates:
        print("Nothing to resolve. No transactions were sent.")
        return 0

    account = load_finalizer_account()
    chain_id, balance = preflight(w3, addresses, account)
    print("GRIDFLEX resolve_markets.py - LIVE MODE\n")
    print(f"  Chain ID:            {chain_id}")
    print(f"  MarketFactory:       {addresses['factory']}")
    print(f"  Signer (finalizer):  {account.address}")
    print(f"  Wallet balance:      {Web3.from_wei(balance, 'ether'):.6f} OKB")
    print(f"  Markets to resolve:  {len(candidates)}")
    for state in candidates:
        yes = yes_would_win(state.reading_value, state.threshold)
        print(f"    {state.address}  {state.metric_name} {state.day_key} -> {'YES' if yes else 'NO'}")
    if input('\nType "yes" to continue: ').strip() != "yes":
        summary.mode = "live (cancelled at confirmation)"
        print("Cancelled. No transactions were sent.")
        return 0

    log_path = LOGS_DIR / datetime.now(timezone.utc).strftime("resolve-markets-%Y%m%dT%H%M%SZ.log")
    for state in candidates:
        # Anyone can resolve; someone may have since this run read the chain.
        if not still_unsettled(w3, state.address):
            summary.raced.append(state.address)
            print(f"SKIP {state.address}: already settled by someone else.")
            continue
        predicted = yes_would_win(state.reading_value, state.threshold)
        tx_hash, gas_cost, yes_won, oracle_value = resolve_market(w3, account, state.address, log_path)
        outcome = "YES" if yes_won else "NO"
        summary.resolved.append(
            {"market": state.address, "outcome": outcome, "txHash": tx_hash, "gasCost": gas_cost}
        )
        print(f"RESOLVED {state.address} -> {outcome}  tx {tx_hash}")
        # Both sides of this check come from chain data that can't be stale:
        # the event is in the resolve receipt, the reading was final before
        # the transaction was sent and can no longer change.
        if oracle_value != state.reading_value or yes_won != predicted:
            raise PublisherError(
                f"{state.address}: the Resolved event says {outcome} on "
                f"{format_value(oracle_value, state.metric_name)}, but the final reading is "
                f"{format_value(state.reading_value, state.metric_name)} "
                f"({'YES' if predicted else 'NO'}) - stop and investigate before resolving more."
            )
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    summary = Summary()
    try:
        return run(args, summary)
    except (PublisherError, KeyboardInterrupt) as exc:
        message = "Interrupted by operator." if isinstance(exc, KeyboardInterrupt) else str(exc)
        summary.error = message
        print(f"ERROR: {message}", file=sys.stderr)
        return 1
    finally:
        print_summary(summary)


if __name__ == "__main__":
    raise SystemExit(main())
