#!/usr/bin/env python3
"""Finalize GRIDFLEX readings already published to GridOracle.

Dry-run is the default. Live mode requires a finalizer key, successful
preflight checks, and an interactive ``yes`` confirmation. ``--verify`` is a
separate, read-only mode that needs no key at all.

Implements shared/finalize-spec.md. Reuses publish.py's ledger I/O, key-source
pattern, revert classification, chain preflight shape, RPC pacing, and audit-
trail conventions rather than duplicating them (finalize-spec.md §0) - import
publish, don't copy it, so a fix to one script's shared logic can't silently
drift from the other's.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from eth_account import Account
from hexbytes import HexBytes
from web3 import Web3
from web3.exceptions import TimeExhausted

from publish import (
    DEFAULT_RPC_URL,
    EXPECTED_CHAIN_ID,
    EXPECTED_METRICS,
    LEDGER_PATH,
    LOGS_DIR,
    MAX_GAS_BUMPS,
    RECEIPT_TIMEOUT_SECONDS,
    ROOT,
    MetricReading,
    PublisherError,
    RevertClassification,
    append_log,
    build_error_selectors,
    chain_reading,
    classify_revert,
    collect_readings,
    ledger_entry_from_chain,
    load_contract,
    load_deployment,
    load_ledger,
    make_web3,
    parse_day,
    save_ledger,
)

DEMO_MARKETS_PATH = ROOT / "shared" / "demo-markets.md"
SUMMARY_TABLE_HEADING = "## Summary table"
SUMMARY_TABLE_COLUMNS = 7
RPC_COURTESY_SLEEP = 0.5
CONFIRMATION_LIST_CAP = 25
CONFIRMATION_SAMPLE_SIZE = 10

STATUS_NOT_PUBLISHED = "not_published"
STATUS_ALREADY_FINALIZED = "already_finalized"
STATUS_WAITING = "waiting"
STATUS_VALUE_MISMATCH = "value_mismatch"
STATUS_ELIGIBLE = "eligible"


@dataclass(frozen=True)
class Evaluation:
    reading: MetricReading
    status: str
    current: dict[str, Any] | None
    finalizable_at: int | None = None


@dataclass
class Summary:
    finalized: int = 0
    not_yet_eligible: int = 0
    already_finalized: int = 0
    not_published: int = 0
    failed: int = 0
    total_gas_cost: int = 0


def format_duration(seconds: int) -> str:
    seconds = max(0, seconds)
    minutes, secs = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h{minutes:02d}m"
    if minutes:
        return f"{minutes}m"
    return f"{secs}s"


def format_wall_clock(epoch_seconds: int) -> str:
    return (
        datetime.fromtimestamp(epoch_seconds, tz=timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def load_finalizer_account():
    keystore_path = os.environ.get("FINALIZER_KEYSTORE_PATH", "").strip()
    env_key = os.environ.get("FINALIZER_PRIVATE_KEY", "").strip()
    if keystore_path:
        path = Path(keystore_path).expanduser()
        try:
            keystore = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PublisherError("Finalizer keystore cannot be read or is not valid JSON.") from exc
        password = getpass.getpass("Enter the finalizer keystore password (hidden): ")
        try:
            private_key = Account.decrypt(keystore, password)
        except (ValueError, TypeError) as exc:
            raise PublisherError(
                "Finalizer keystore password is wrong or the keystore is invalid."
            ) from exc
        finally:
            password = ""
        return Account.from_key(private_key)
    if env_key:
        try:
            return Account.from_key(env_key)
        except (ValueError, TypeError) as exc:
            raise PublisherError("FINALIZER_PRIVATE_KEY is malformed.") from exc
    raise PublisherError(
        "No finalizer key configured. Set FINALIZER_KEYSTORE_PATH (recommended) "
        "or FINALIZER_PRIVATE_KEY."
    )


def preflight(w3: Web3, contract) -> int:
    """finalize-spec.md §4: chain ID and contract code only - no reporter
    check, since finalize() is permissionless and has no access control to
    get wrong."""
    try:
        chain_id = w3.eth.chain_id
        code = w3.eth.get_code(contract.address)
    except Exception as exc:
        raise PublisherError(f"RPC preflight failed: {type(exc).__name__}") from exc
    if chain_id != EXPECTED_CHAIN_ID:
        raise PublisherError(f"Wrong chain: got {chain_id}, expected {EXPECTED_CHAIN_ID}.")
    if not code or code == HexBytes("0x"):
        raise PublisherError(f"No contract bytecode at oracle address {contract.address}.")
    return chain_id


def get_dispute_window(contract) -> int:
    return int(contract.functions.disputeWindow().call())


def evaluate_reading(contract, dispute_window: int, reading: MetricReading, now: int) -> Evaluation:
    """finalize-spec.md §1-§3: discovery, eligibility and the value-match
    safety check, all from a fresh on-chain read - never from the ledger."""
    current = chain_reading(contract, reading)
    if current is None:
        return Evaluation(reading, STATUS_NOT_PUBLISHED, None)
    if current["finalized"]:
        return Evaluation(reading, STATUS_ALREADY_FINALIZED, current)
    finalizable_at = current["publishedAt"] + dispute_window
    if now < finalizable_at:
        return Evaluation(reading, STATUS_WAITING, current, finalizable_at)
    if current["value"] != reading.value:
        return Evaluation(reading, STATUS_VALUE_MISMATCH, current, finalizable_at)
    return Evaluation(reading, STATUS_ELIGIBLE, current, finalizable_at)


def _table_lines(text: str, heading: str) -> list[str]:
    if heading not in text:
        raise PublisherError(
            f"{DEMO_MARKETS_PATH}: no '{heading}' section found - has the file's structure "
            "changed? See shared/finalize-spec.md §6.1."
        )
    after = text.split(heading, 1)[1]
    lines: list[str] = []
    started = False
    for line in after.splitlines():
        stripped = line.strip()
        if not started:
            if not stripped:
                continue
            if not stripped.startswith("|"):
                break
            started = True
        if not stripped.startswith("|"):
            break
        lines.append(stripped)
    return lines


def parse_demo_markets_summary_table(path: Path | None = None) -> list[tuple[str, int]]:
    """finalize-spec.md §6.1: parse the Summary table, failing loudly (not
    silently checking fewer rows) if its shape has changed."""
    path = path or DEMO_MARKETS_PATH
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise PublisherError(f"Cannot read {path} for --verify's demo-market table.") from exc

    table_lines = _table_lines(text, SUMMARY_TABLE_HEADING)
    if len(table_lines) < 3:
        raise PublisherError(
            f"{path}: expected a pipe-delimited table with a header, a divider, and at least "
            f"one data row under '{SUMMARY_TABLE_HEADING}', found {len(table_lines)} table "
            f"line(s) - has the table's format changed? See shared/finalize-spec.md §6.1."
        )

    def cells_of(line: str) -> list[str]:
        return [cell.strip() for cell in line.strip("|").split("|")]

    header_cells = cells_of(table_lines[0])
    if len(header_cells) != SUMMARY_TABLE_COLUMNS:
        raise PublisherError(
            f"{path}: expected {SUMMARY_TABLE_COLUMNS} columns in the Summary table, found "
            f"{len(header_cells)} - has the table's format changed? See shared/finalize-spec.md §6.1."
        )

    rows: list[tuple[str, int]] = []
    for line in table_lines[2:]:
        cells = cells_of(line)
        if len(cells) != SUMMARY_TABLE_COLUMNS:
            raise PublisherError(
                f"{path}: expected {SUMMARY_TABLE_COLUMNS} columns in the Summary table, found "
                f"{len(cells)} in row {line!r} - has the table's format changed? "
                "See shared/finalize-spec.md §6.1."
            )
        metric_id = cells[1].strip("`")
        day_key_text = cells[3].strip("`")
        if metric_id not in EXPECTED_METRICS or not day_key_text.isdigit():
            raise PublisherError(
                f"{path}: could not parse a metric/dayKey pair from row {line!r} - has the "
                "table's format changed? See shared/finalize-spec.md §6.1."
            )
        rows.append((metric_id, int(day_key_text)))

    if not rows:
        raise PublisherError(f"{path}: Summary table parsed but contained zero data rows.")
    return rows


def run_check(oracle_address: str, rpc_url: str) -> int:
    account = load_finalizer_account()
    w3 = make_web3(rpc_url)
    contract = load_contract(w3, oracle_address)
    chain_id = preflight(w3, contract)
    balance = w3.eth.get_balance(account.address)
    print("GRIDFLEX finalizer preflight: PASS")
    print(f"  Chain ID:            {chain_id}")
    print(f"  Oracle contract:     {oracle_address}")
    print(f"  Signer (finalizer):  {account.address}")
    print(f"  Wallet balance:      {Web3.from_wei(balance, 'ether'):.6f} OKB")
    return 0


def run_verify(args: argparse.Namespace, oracle_address: str, rpc_url: str) -> int:
    """finalize-spec.md §6: read-only, no wallet needed at all."""
    w3 = make_web3(rpc_url)
    contract = load_contract(w3, oracle_address)
    preflight(w3, contract)
    dispute_window = get_dispute_window(contract)
    now = int(time.time())

    if args.metric and args.day_key is not None:
        rows = [(args.metric[0], args.day_key)]
    else:
        rows = parse_demo_markets_summary_table()

    all_ok = True
    for metric_id, day_key in rows:
        probe = MetricReading(
            path=Path("<verify>"),
            metric_id=metric_id,
            day_key=day_key,
            market_day_start_utc=0,
            market_day_end_utc=0,
            value=0,
            source_hash="00" * 32,
        )
        current = chain_reading(contract, probe)
        time.sleep(RPC_COURTESY_SLEEP)
        label = f"{metric_id:<25} dayKey {day_key}"
        if current is None:
            print(f"{label}   NOT PUBLISHED")
            all_ok = False
            continue
        if current["finalized"]:
            print(f"{label}   PUBLISHED, FINALIZED")
            continue
        finalizable_at = current["publishedAt"] + dispute_window
        remaining = finalizable_at - now
        print(
            f"{label}   PUBLISHED, not finalized "
            f"({format_duration(remaining)} remaining, eligible at "
            f"{format_wall_clock(finalizable_at)})"
        )
        all_ok = False
    return 0 if all_ok else 1


def attempt_finalize(
    w3: Web3,
    contract,
    account,
    reading: MetricReading,
    nonce: int,
    log_path: Path,
    selectors: dict[str, str],
    gas_price: int,
) -> tuple[str, str, int, int]:
    """finalize-spec.md §5: per-reading isolation - this never raises for a
    revert or a transport failure, it reports that one reading as FAILED and
    lets the caller move on to the next."""
    function = contract.functions.finalize(reading.metric_hash, reading.day_key)
    try:
        estimated_gas = function.estimate_gas({"from": account.address})
    except Exception as exc:
        classification = classify_revert(exc, selectors)
        if classification.is_expected:
            append_log(log_path, reading, "", "EXPECTED_ALREADY_FINALIZED")
            return "ALREADY_FINALIZED", "finalized before our transaction", 0, nonce
        detail = classification.error_name or f"unrecognized failure ({type(exc).__name__}: {exc})"
        append_log(log_path, reading, "", "FAILED")
        return "FAILED", detail, 0, nonce

    gas_limit = max(int(estimated_gas * 1.2), estimated_gas + 10_000)

    def broadcast(target_nonce: int, price: int):
        tx = function.build_transaction(
            {
                "from": account.address,
                "nonce": target_nonce,
                "chainId": EXPECTED_CHAIN_ID,
                "gas": gas_limit,
                "gasPrice": price,
            }
        )
        signed = account.sign_transaction(tx)
        return w3.eth.send_raw_transaction(signed.raw_transaction)

    try:
        for attempt in range(MAX_GAS_BUMPS + 1):
            bumped_price = int(gas_price * (1.125**attempt)) + attempt
            try:
                tx_hash = broadcast(nonce, bumped_price)
            except ValueError as exc:
                message = str(exc).lower()
                if "nonce too low" not in message or attempt != 0:
                    raise
                fresh_nonce = w3.eth.get_transaction_count(account.address, "pending")
                if fresh_nonce == nonce:
                    raise
                print(
                    f"{reading.ledger_key}: nonce too low (local {nonce}, chain {fresh_nonce}); "
                    "re-syncing and retrying once.",
                    file=sys.stderr,
                )
                nonce = fresh_nonce
                tx_hash = broadcast(nonce, bumped_price)

            last_hash = "0x" + tx_hash.hex().removeprefix("0x")
            try:
                receipt = w3.eth.wait_for_transaction_receipt(
                    tx_hash, timeout=RECEIPT_TIMEOUT_SECONDS, poll_latency=1
                )
            except TimeExhausted:
                if attempt < MAX_GAS_BUMPS:
                    print(
                        f"{reading.ledger_key}: transaction pending; replacing with bumped gas "
                        f"({attempt + 1}/{MAX_GAS_BUMPS}).",
                        file=sys.stderr,
                    )
                    continue
                append_log(log_path, reading, last_hash, "FAILED_TIMEOUT")
                return "FAILED", "still pending after two gas bumps", 0, nonce + 1

            if receipt.status != 1:
                try:
                    function.call({"from": account.address}, block_identifier=receipt.blockNumber)
                    replay_exc: Exception | None = None
                except Exception as exc:
                    replay_exc = exc
                classification = (
                    classify_revert(replay_exc, selectors)
                    if replay_exc is not None
                    else RevertClassification(is_expected=False, error_name=None)
                )
                if classification.is_expected:
                    append_log(log_path, reading, last_hash, "EXPECTED_ALREADY_FINALIZED")
                    return (
                        "ALREADY_FINALIZED",
                        "finalized before our transaction landed",
                        0,
                        nonce + 1,
                    )
                detail = classification.error_name or "unrecognized revert"
                append_log(log_path, reading, last_hash, "FAILED_REVERT")
                return "FAILED", detail, 0, nonce + 1

            append_log(log_path, reading, last_hash, "FINALIZED")
            return "FINALIZED", "", receipt.gasUsed * bumped_price, nonce + 1
        raise AssertionError("unreachable")
    except Exception as exc:
        append_log(log_path, reading, "", f"FAILED_{type(exc).__name__}")
        return "FAILED", f"{type(exc).__name__}: {exc}", 0, nonce


def print_plan(evaluations: list[Evaluation], invalid: list[str]) -> None:
    counts: dict[str, int] = {}
    for evaluation in evaluations:
        counts[evaluation.status] = counts.get(evaluation.status, 0) + 1
    print("GRIDFLEX finalize plan")
    print(f"  Would finalize:                  {counts.get(STATUS_ELIGIBLE, 0)}")
    print(f"  Not yet eligible:                {counts.get(STATUS_WAITING, 0)}")
    print(f"  Already finalized (skipped):     {counts.get(STATUS_ALREADY_FINALIZED, 0)}")
    print(f"  Not published (skipped):         {counts.get(STATUS_NOT_PUBLISHED, 0)}")
    print(f"  Value mismatch (failed):         {counts.get(STATUS_VALUE_MISMATCH, 0)}")
    print(f"  Invalid files (skipped):         {len(invalid)}")
    for failure in invalid:
        print(f"  INVALID {failure}", file=sys.stderr)


def confirmation_banner(
    chain_id: int, oracle: str, signer: str, balance: int, eligible: list[Evaluation], gas_price: int
) -> None:
    """finalize-spec.md §4.2: list readings individually up to a cap,
    summarize above it - a multi-thousand-line banner defeats the purpose."""
    estimated_seconds = len(eligible) * 1.5
    estimated_cost_wei = len(eligible) * 60_000 * gas_price
    print("\nGRIDFLEX finalize.py - LIVE MODE\n")
    print(f"  Chain ID:             {chain_id}")
    print(f"  Oracle contract:      {oracle}")
    print(f"  Finalizer signer:     {signer}")
    print(f"  Wallet balance:       {Web3.from_wei(balance, 'ether'):.6f} OKB")
    print(f"  Readings to finalize: {len(eligible)}")
    if len(eligible) <= CONFIRMATION_LIST_CAP:
        for evaluation in eligible:
            reading = evaluation.reading
            print(f"    {reading.metric_id:<25} dayKey {reading.day_key}   value {evaluation.current['value']}")
    else:
        counts: dict[str, int] = {}
        for evaluation in eligible:
            counts[evaluation.reading.metric_id] = counts.get(evaluation.reading.metric_id, 0) + 1
        for metric_id in sorted(counts):
            print(f"    {metric_id}: {counts[metric_id]}")
        print(f"  Sample (first {CONFIRMATION_SAMPLE_SIZE}):")
        for evaluation in eligible[:CONFIRMATION_SAMPLE_SIZE]:
            reading = evaluation.reading
            print(f"    {reading.metric_id:<25} dayKey {reading.day_key}   value {evaluation.current['value']}")
    print(f"  Estimated duration:   ~{max(1, round(estimated_seconds / 60))} minutes")
    print(f"  Estimated cost:       ~{Web3.from_wei(estimated_cost_wei, 'ether'):.6f} OKB")


def print_summary(summary: Summary, started: float, invalid: list[str]) -> None:
    elapsed = int(time.monotonic() - started)
    print("\nGRIDFLEX finalize summary")
    print(f"  Finalized:                       {summary.finalized}")
    print(f"  Not yet eligible (skipped):      {summary.not_yet_eligible}")
    print(f"  Already finalized (skipped):     {summary.already_finalized}")
    print(f"  Not published (skipped):         {summary.not_published}")
    print(f"  Failed (skipped, this reading):  {summary.failed}")
    print(f"  Invalid files (skipped):         {len(invalid)}")
    print(f"  Wall-clock time:                 {elapsed // 60:02d}:{elapsed % 60:02d}")
    print(f"  Total gas spent:                 {Web3.from_wei(summary.total_gas_cost, 'ether'):.6f} OKB")
    print(f"  Ledger updated:                  {LEDGER_PATH}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--metric", action="append", choices=EXPECTED_METRICS, help="repeatable metric filter"
    )
    date_group = parser.add_mutually_exclusive_group()
    date_group.add_argument("--start", type=parse_day)
    date_group.add_argument("--days", type=int)
    parser.add_argument("--end", type=parse_day)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--day-key", type=parse_day)
    parser.add_argument(
        "--published-only",
        action="store_true",
        help="restrict candidates to data/publish-ledger.json entries with a txHash - skips "
        "metric-day files that were never submitted, instead of round-tripping to the chain "
        "for each one just to learn that. Off by default: every discovered metric file is a "
        "candidate, same as today.",
    )
    return parser


def validate_args(args: argparse.Namespace) -> None:
    if args.verify:
        if (
            args.live
            or args.check
            or args.start
            or args.end
            or args.days
            or args.limit
            or args.published_only
        ):
            raise PublisherError(
                "--verify is mutually exclusive with --live/--check, the "
                "date-range/--limit flags, and --published-only."
            )
        if bool(args.metric) != (args.day_key is not None):
            raise PublisherError(
                "--verify's ad hoc mode requires both --metric and --day-key together."
            )
        if args.metric and len(args.metric) != 1:
            raise PublisherError(
                "--verify's ad hoc mode takes exactly one --metric, not a repeated filter."
            )
        return
    if args.day_key is not None:
        raise PublisherError("--day-key is only valid together with --verify.")
    if args.check and args.published_only:
        raise PublisherError("--published-only has no effect with --check; drop one.")
    if args.days is not None and args.days <= 0:
        raise PublisherError("--days must be positive.")
    if args.limit is not None and args.limit <= 0:
        raise PublisherError("--limit must be positive.")
    if args.start and args.end and args.start > args.end:
        raise PublisherError("--start must not be after --end.")
    if args.check and args.live:
        raise PublisherError("Use --check and --live as separate commands.")


def main(argv: list[str] | None = None) -> int:
    started = time.monotonic()
    args = build_parser().parse_args(argv)
    summary = Summary()
    invalid: list[str] = []
    try:
        validate_args(args)
        _, oracle_address = load_deployment()
        rpc_url = os.environ.get("XLAYER_RPC_URL", DEFAULT_RPC_URL)

        if args.verify:
            return run_verify(args, oracle_address, rpc_url)

        if args.check:
            return run_check(oracle_address, rpc_url)

        w3 = make_web3(rpc_url)
        contract = load_contract(w3, oracle_address)
        chain_id = preflight(w3, contract)
        dispute_window = get_dispute_window(contract)

        readings, invalid = collect_readings(args)
        ledger = load_ledger()
        if args.published_only:
            # Only publish.py's own ledger says a reading was ever actually
            # submitted (a txHash) - the local metric file existing says
            # nothing about that. Filtering here, before the RPC loop below,
            # is what skips the ~1,440 never-published files instead of
            # round-tripping to the chain for each one just to learn
            # STATUS_NOT_PUBLISHED.
            readings = [
                r
                for r in readings
                if isinstance(ledger.get(r.ledger_key), dict) and ledger[r.ledger_key].get("txHash")
            ]
        if args.limit is not None:
            readings = readings[: args.limit]

        now = int(time.time())
        evaluations: list[Evaluation] = []
        eligible: list[Evaluation] = []
        for reading in readings:
            time.sleep(RPC_COURTESY_SLEEP)
            evaluation = evaluate_reading(contract, dispute_window, reading, now)
            evaluations.append(evaluation)
            if evaluation.current is not None:
                ledger[reading.ledger_key] = ledger_entry_from_chain(
                    reading, evaluation.current, ledger.get(reading.ledger_key)
                )
            # Tallied inline, not in a second pass over `evaluations`, so a mid-loop
            # exception (an RPC hiccup on reading N of ~1,448) still leaves `summary`
            # holding accurate counts for readings 1..N-1 - required for the summary
            # to print correctly on every exit path (finalize-spec.md §7).
            if evaluation.status == STATUS_NOT_PUBLISHED:
                summary.not_published += 1
            elif evaluation.status == STATUS_ALREADY_FINALIZED:
                summary.already_finalized += 1
            elif evaluation.status == STATUS_WAITING:
                summary.not_yet_eligible += 1
                remaining = evaluation.finalizable_at - now
                print(
                    f"WAITING {reading.ledger_key}: {format_duration(remaining)} remaining "
                    f"(eligible at {format_wall_clock(evaluation.finalizable_at)})"
                )
            elif evaluation.status == STATUS_VALUE_MISMATCH:
                summary.failed += 1
                print(
                    f"VALUE MISMATCH {reading.ledger_key}: on-chain value "
                    f"{evaluation.current['value']} differs from local metric file value "
                    f"{reading.value}; refusing to finalize (finalization is irreversible) - "
                    "investigate before ever finalizing this reading.",
                    file=sys.stderr,
                )
            elif evaluation.status == STATUS_ELIGIBLE:
                if evaluation.current["sourceHash"] != reading.source_hash:
                    print(
                        f"NOTE {reading.ledger_key}: on-chain sourceHash differs but value "
                        "matches; not a blocker.",
                        file=sys.stderr,
                    )
                eligible.append(evaluation)
        save_ledger(ledger)

        print_plan(evaluations, invalid)

        if not args.live:
            print("\nDRY RUN ONLY - no transactions were sent.")
            print_summary(summary, started, invalid)
            return 1 if (summary.failed or invalid) else 0

        if invalid:
            print("ERROR: live finalization refused because metric validation failed.", file=sys.stderr)
            print_summary(summary, started, invalid)
            return 1

        if not eligible:
            print("Nothing to finalize. No transactions were sent.")
            print_summary(summary, started, invalid)
            return 1 if summary.failed else 0

        account = load_finalizer_account()
        balance = w3.eth.get_balance(account.address)
        gas_price = w3.eth.gas_price
        confirmation_banner(chain_id, oracle_address, account.address, balance, eligible, gas_price)
        if input('\nType "yes" to continue: ').strip() != "yes":
            print("Cancelled. No transactions were sent.")
            print_summary(summary, started, invalid)
            return 1 if summary.failed else 0

        selectors = build_error_selectors(contract.abi)
        nonce = w3.eth.get_transaction_count(account.address, "pending")
        log_path = LOGS_DIR / datetime.now(timezone.utc).strftime("finalize-%Y%m%dT%H%M%SZ.log")
        for evaluation in eligible:
            reading = evaluation.reading
            outcome, detail, cost, nonce = attempt_finalize(
                w3, contract, account, reading, nonce, log_path, selectors, gas_price
            )
            summary.total_gas_cost += cost
            current = chain_reading(contract, reading)
            time.sleep(RPC_COURTESY_SLEEP)
            if current is not None:
                ledger[reading.ledger_key] = ledger_entry_from_chain(
                    reading, current, ledger.get(reading.ledger_key)
                )
            save_ledger(ledger)
            if outcome == "FINALIZED":
                summary.finalized += 1
                print(f"FINALIZED {reading.ledger_key}")
            elif outcome == "ALREADY_FINALIZED":
                summary.already_finalized += 1
                print(f"EXPECTED_ALREADY_FINALIZED {reading.ledger_key} ({detail})")
            else:
                summary.failed += 1
                print(f"FAILED {reading.ledger_key}: {detail}", file=sys.stderr)

        print_summary(summary, started, invalid)
        return 1 if (summary.failed or invalid) else 0
    except (PublisherError, KeyboardInterrupt) as exc:
        message = "Interrupted by operator." if isinstance(exc, KeyboardInterrupt) else str(exc)
        print(f"ERROR: {message}", file=sys.stderr)
        if not (args.check or args.verify):
            print_summary(summary, started, invalid)
        return 1
    except Exception as exc:
        # finalize-spec.md §7: the summary must print on every exit path, including
        # an abort - an unclassified error (a dropped RPC connection, a transport
        # timeout) during discovery/evaluation must not skip it.
        print(f"ERROR: unexpected failure: {type(exc).__name__}: {exc}", file=sys.stderr)
        if not (args.check or args.verify):
            print_summary(summary, started, invalid)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
