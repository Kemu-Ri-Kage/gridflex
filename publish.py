#!/usr/bin/env python3
"""Safely publish committed GRIDFLEX metric readings to GridOracle.

Dry-run is the default. Live mode requires a matching reporter key, successful
preflight checks, and an interactive ``yes`` confirmation.
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
from typing import Any, Iterable

from eth_account import Account
from hexbytes import HexBytes
from web3 import HTTPProvider, Web3
from web3.exceptions import TimeExhausted

from scripts.validate_metrics import validate as validate_metric_file


ROOT = Path(__file__).resolve().parent
METRICS_DIR = ROOT / "data" / "metrics"
LEDGER_PATH = ROOT / "data" / "publish-ledger.json"
ADDRESSES_PATH = ROOT / "shared" / "addresses.json"
ABI_PATH = ROOT / "shared" / "abi" / "GridOracle.json"
LOGS_DIR = ROOT / "logs"
DEFAULT_RPC_URL = "https://testrpc.xlayer.tech/terigon"
EXPECTED_CHAIN_ID = 1952
EXPECTED_METRICS = (
    "ERCOT_HBNORTH_DA_AVG",
    "ERCOT_WEST_NORTH_DA_BASIS",
    "ERCOT_LOAD_WEIGHTED_DA_INDEX",
    "ERCOT_HBWEST_NEG_INTERVALS",
)
INT256_MIN = -(2**255)
INT256_MAX = 2**255 - 1
RECEIPT_TIMEOUT_SECONDS = 90
MAX_GAS_BUMPS = 2
EXPECTED_REVERT_ERROR = "ReadingAlreadyFinalized"


class PublisherError(RuntimeError):
    """A safe, user-facing publisher failure."""


@dataclass(frozen=True)
class MetricReading:
    path: Path
    metric_id: str
    day_key: int
    market_day_start_utc: int
    market_day_end_utc: int
    value: int
    source_hash: str

    @property
    def ledger_key(self) -> str:
        return f"{self.metric_id}:{self.day_key}"

    @property
    def metric_hash(self) -> bytes:
        return Web3.keccak(text=self.metric_id)


@dataclass
class Plan:
    submit: list[MetricReading]
    already_published: int = 0
    already_finalized: int = 0
    hash_drift: int = 0


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise PublisherError(f"Required file is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise PublisherError(f"Invalid JSON in {path}: {exc}") from exc


def load_deployment() -> tuple[int, str]:
    config = load_json(ADDRESSES_PATH)
    try:
        chain_id = int(config["chainId"])
        oracle = Web3.to_checksum_address(config["GridOracle"])
    except (KeyError, TypeError, ValueError) as exc:
        raise PublisherError(f"Invalid deployment config: {ADDRESSES_PATH}") from exc
    if chain_id != EXPECTED_CHAIN_ID:
        raise PublisherError(
            f"Deployment config has chainId {chain_id}; expected {EXPECTED_CHAIN_ID}."
        )
    return chain_id, oracle


def load_ledger() -> dict[str, dict[str, Any]]:
    if not LEDGER_PATH.exists():
        return {}
    ledger = load_json(LEDGER_PATH)
    if not isinstance(ledger, dict):
        raise PublisherError(f"Ledger must be a JSON object: {LEDGER_PATH}")
    return ledger


def save_ledger(ledger: dict[str, dict[str, Any]]) -> None:
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = LEDGER_PATH.with_suffix(".json.tmp")
    payload = json.dumps(ledger, indent=2, sort_keys=True) + "\n"
    with temporary.open("w", encoding="utf-8") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, LEDGER_PATH)


def normalize_hash(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return value.lower().removeprefix("0x")


def load_reading(path: Path) -> MetricReading:
    validate_metric_file(path)
    record = load_json(path)
    metric_id = record["metricId"]
    if metric_id not in EXPECTED_METRICS:
        raise ValueError(f"metricId is not frozen for on-chain publication: {metric_id}")
    value = record["value"]
    if not INT256_MIN <= value <= INT256_MAX:
        raise ValueError("value does not fit int256")
    source_hash = normalize_hash(record["sourceHash"])
    if len(bytes.fromhex(source_hash)) != 32:
        raise ValueError("sourceHash must decode to exactly 32 bytes")
    if int(source_hash, 16) == 0:
        raise ValueError("sourceHash must not be zero")
    return MetricReading(
        path=path,
        metric_id=metric_id,
        day_key=record["dayKey"],
        market_day_start_utc=record["marketDayStartUtc"],
        market_day_end_utc=record["marketDayEndUtc"],
        value=value,
        source_hash=source_hash,
    )


def parse_day(value: str) -> int:
    try:
        parsed = datetime.strptime(value, "%Y%m%d")
    except ValueError as exc:
        raise argparse.ArgumentTypeError("expected a real date in YYYYMMDD form") from exc
    return int(parsed.strftime("%Y%m%d"))


def collect_readings(args: argparse.Namespace) -> tuple[list[MetricReading], list[str]]:
    selected_metrics = set(args.metric or EXPECTED_METRICS)
    readings: list[MetricReading] = []
    invalid: list[str] = []
    for path in sorted(METRICS_DIR.glob("*.json")):
        if not any(path.name.startswith(f"{name}__") for name in selected_metrics):
            continue
        try:
            reading = load_reading(path)
        except (OSError, ValueError, KeyError, TypeError, PublisherError) as exc:
            invalid.append(f"{path.name}: {exc}")
            continue
        readings.append(reading)

    readings.sort(key=lambda item: (item.day_key, item.metric_id))
    if args.start is not None:
        readings = [item for item in readings if item.day_key >= args.start]
    if args.end is not None:
        readings = [item for item in readings if item.day_key <= args.end]
    if args.days is not None and readings:
        unique_days = sorted({item.day_key for item in readings})
        allowed_days = set(unique_days[-args.days :])
        readings = [item for item in readings if item.day_key in allowed_days]
    return readings, invalid


def plan_from_ledger(
    readings: Iterable[MetricReading], ledger: dict[str, dict[str, Any]]
) -> Plan:
    plan = Plan(submit=[])
    for reading in readings:
        entry = ledger.get(reading.ledger_key)
        if not isinstance(entry, dict):
            plan.submit.append(reading)
            continue
        status = entry.get("status")
        old_value = entry.get("value")
        old_hash = normalize_hash(entry.get("sourceHash"))
        if status == "finalized" and old_value != reading.value:
            raise PublisherError(
                f"{reading.ledger_key}: local value differs from an immutable finalized reading."
            )
        if old_value == reading.value and status in {"confirmed", "finalized"}:
            if old_hash != reading.source_hash:
                print(
                    f"WARNING {reading.ledger_key}: sourceHash drift with unchanged value; "
                    "skipping without resetting the dispute window.",
                    file=sys.stderr,
                )
                plan.hash_drift += 1
            if status == "finalized":
                plan.already_finalized += 1
            else:
                plan.already_published += 1
            continue
        plan.submit.append(reading)
    return plan


def make_web3(rpc_url: str) -> Web3:
    return Web3(HTTPProvider(rpc_url, request_kwargs={"timeout": 30}))


def load_contract(w3: Web3, oracle_address: str):
    abi = load_json(ABI_PATH)
    return w3.eth.contract(address=oracle_address, abi=abi)


@dataclass(frozen=True)
class RevertClassification:
    is_expected: bool
    error_name: str | None


def build_error_selectors(abi: list[dict[str, Any]]) -> dict[str, str]:
    """Map each custom error's 4-byte selector (hex, no 0x prefix) to its name.

    Selectors are derived from the ABI's own error signatures rather than
    hardcoded, so a contract upgrade that changes an error's argument types
    cannot silently desync this table from `shared/abi/GridOracle.json`.
    """
    selectors: dict[str, str] = {}
    for item in abi:
        if item.get("type") != "error":
            continue
        types = ",".join(inp["type"] for inp in item.get("inputs", []))
        signature = f"{item['name']}({types})"
        selector = Web3.keccak(text=signature)[:4].hex()
        selectors[selector.lower()] = item["name"]
    return selectors


def classify_revert(exc: Exception, selectors: dict[str, str]) -> RevertClassification:
    """Classify a revert per shared/publish-spec.md §2.7.

    ReadingAlreadyFinalized is EXPECTED (information, not failure). Every
    other named error, and any revert whose selector we don't recognize, is
    UNEXPECTED — an unknown failure is not safe to continue through.
    """
    data = getattr(exc, "data", None)
    if isinstance(data, dict):
        data = data.get("data")
    if not isinstance(data, str):
        return RevertClassification(is_expected=False, error_name=None)
    hex_data = data.removeprefix("0x")
    error_name = selectors.get(hex_data[:8].lower()) if len(hex_data) >= 8 else None
    if error_name is None:
        return RevertClassification(is_expected=False, error_name=None)
    return RevertClassification(
        is_expected=error_name == EXPECTED_REVERT_ERROR, error_name=error_name
    )


def load_reporter_account():
    keystore_path = os.environ.get("REPORTER_KEYSTORE_PATH", "").strip()
    env_key = os.environ.get("REPORTER_PRIVATE_KEY", "").strip()
    if keystore_path:
        path = Path(keystore_path).expanduser()
        try:
            keystore = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PublisherError("Reporter keystore cannot be read or is not valid JSON.") from exc
        password = getpass.getpass("Enter the reporter keystore password (hidden): ")
        try:
            private_key = Account.decrypt(keystore, password)
        except (ValueError, TypeError) as exc:
            raise PublisherError("Reporter keystore password is wrong or the keystore is invalid.") from exc
        finally:
            password = ""
        return Account.from_key(private_key)
    if env_key:
        try:
            return Account.from_key(env_key)
        except (ValueError, TypeError) as exc:
            raise PublisherError("REPORTER_PRIVATE_KEY is malformed.") from exc
    raise PublisherError(
        "No reporter key configured. Set REPORTER_KEYSTORE_PATH (recommended) "
        "or REPORTER_PRIVATE_KEY."
    )


def preflight(w3: Web3, contract, account) -> tuple[int, int]:
    try:
        chain_id = w3.eth.chain_id
        code = w3.eth.get_code(contract.address)
        reporter = Web3.to_checksum_address(contract.functions.reporter().call())
        balance = w3.eth.get_balance(account.address)
    except Exception as exc:
        raise PublisherError(f"RPC preflight failed: {type(exc).__name__}") from exc
    if chain_id != EXPECTED_CHAIN_ID:
        raise PublisherError(f"Wrong chain: got {chain_id}, expected {EXPECTED_CHAIN_ID}.")
    if not code or code == HexBytes("0x"):
        raise PublisherError(f"No contract bytecode at oracle address {contract.address}.")
    if Web3.to_checksum_address(account.address) != reporter:
        raise PublisherError(
            f"Wrong reporter key: derived {account.address}, contract expects {reporter}."
        )
    return chain_id, balance


def chain_reading(contract, reading: MetricReading) -> dict[str, Any] | None:
    raw = contract.functions.getReading(reading.metric_hash, reading.day_key).call()
    if int(raw[6]) == 0:
        return None
    return {
        "metricHash": HexBytes(raw[0]).hex(),
        "dayKey": int(raw[1]),
        "marketDayStartUtc": int(raw[2]),
        "marketDayEndUtc": int(raw[3]),
        "value": int(raw[4]),
        "sourceHash": HexBytes(raw[5]).hex().removeprefix("0x"),
        "publishedAt": int(raw[6]),
        "finalized": bool(raw[7]),
    }


def ledger_entry_from_chain(
    reading: MetricReading,
    current: dict[str, Any],
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Merge authoritative chain state without discarding transaction audit data.

    The chain can recover the reading value, source hash, publication time, and
    finalization status, but it cannot reconstruct the original transaction hash,
    nonce, or block number cheaply.  Preserve those fields whenever the ledger
    already has them; only mark an entry as recovered when no local audit row
    exists.
    """
    previous = existing if isinstance(existing, dict) else {}
    entry = {
        "metricId": reading.metric_id,
        "dayKey": reading.day_key,
        "value": current["value"],
        "sourceHash": current["sourceHash"],
        "nonce": previous.get("nonce"),
        "txHash": previous.get("txHash"),
        "blockNumber": previous.get("blockNumber"),
        "status": "finalized" if current["finalized"] else "confirmed",
        "submittedAt": previous.get("submittedAt")
        or datetime.fromtimestamp(current["publishedAt"], tz=timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
    }
    if previous.get("recoveredFromChain") or not previous:
        entry["recoveredFromChain"] = True
    return entry


def protect_against_stale_ledger(
    contract,
    plan: Plan,
    ledger: dict[str, dict[str, Any]],
    submission_limit: int | None = None,
) -> Plan:
    """Check every would-be submission on-chain before live mode.

    This extra guard is necessary for the team's ZIP hand-off workflow: it
    reconstructs missing public ledger rows and prevents an old ZIP from
    silently resetting a reading's dispute window.
    """
    safe_submit: list[MetricReading] = []
    for reading in plan.submit:
        if submission_limit is not None and len(safe_submit) >= submission_limit:
            break
        current = chain_reading(contract, reading)
        time.sleep(0.5)
        if current is None:
            safe_submit.append(reading)
            continue
        if current["value"] == reading.value:
            if current["sourceHash"] != reading.source_hash:
                print(
                    f"WARNING {reading.ledger_key}: on-chain sourceHash differs but value "
                    "matches; recovering ledger and skipping.",
                    file=sys.stderr,
                )
                plan.hash_drift += 1
            ledger[reading.ledger_key] = ledger_entry_from_chain(
                reading, current, ledger.get(reading.ledger_key)
            )
            if current["finalized"]:
                plan.already_finalized += 1
            else:
                plan.already_published += 1
            continue
        if current["finalized"]:
            raise PublisherError(
                f"{reading.ledger_key}: file value differs from immutable on-chain value."
            )
        print(
            f"CORRECTION {reading.ledger_key}: on-chain value {current['value']} "
            f"will be replaced with {reading.value}.",
            file=sys.stderr,
        )
        safe_submit.append(reading)
    plan.submit = safe_submit
    save_ledger(ledger)
    return plan


def reconcile(contract, ledger: dict[str, dict[str, Any]]) -> None:
    failures: list[str] = []
    for key, entry in sorted(ledger.items()):
        try:
            metric_id, day_text = key.rsplit(":", 1)
            probe = MetricReading(
                path=Path("<ledger>"),
                metric_id=metric_id,
                day_key=int(day_text),
                market_day_start_utc=0,
                market_day_end_utc=0,
                value=int(entry["value"]),
                source_hash=normalize_hash(entry["sourceHash"]),
            )
            current = chain_reading(contract, probe)
            if current is None:
                failures.append(f"{key}: missing on-chain")
            elif current["value"] != probe.value:
                failures.append(
                    f"{key}: value ledger={probe.value} chain={current['value']}"
                )
            elif current["sourceHash"] != probe.source_hash:
                failures.append(f"{key}: sourceHash differs")
            else:
                if current["finalized"]:
                    entry["status"] = "finalized"
            time.sleep(0.5)
        except Exception as exc:
            failures.append(f"{key}: {type(exc).__name__}")
    save_ledger(ledger)
    if failures:
        raise PublisherError("Ledger reconciliation failed:\n- " + "\n- ".join(failures))
    print(f"Ledger reconciliation passed for {len(ledger)} entries.")


def submitted_entry(reading: MetricReading, nonce: int) -> dict[str, Any]:
    return {
        "metricId": reading.metric_id,
        "dayKey": reading.day_key,
        "value": reading.value,
        "sourceHash": reading.source_hash,
        "nonce": nonce,
        "txHash": None,
        "blockNumber": None,
        "status": "submitted",
        "submittedAt": utc_now(),
    }


def has_pending_submitted_entries(ledger: dict[str, dict[str, Any]]) -> bool:
    return any(
        isinstance(entry, dict) and entry.get("status") == "submitted"
        for entry in ledger.values()
    )


def recover_submitted_entries(
    w3: Web3, contract, account, ledger: dict[str, dict[str, Any]]
) -> None:
    pending_entries = [
        (key, entry)
        for key, entry in ledger.items()
        if isinstance(entry, dict) and entry.get("status") == "submitted"
    ]
    if not pending_entries:
        return
    pending_nonce = w3.eth.get_transaction_count(account.address, "pending")
    for key, entry in pending_entries:
        try:
            tx_hash = entry.get("txHash")
            if tx_hash:
                try:
                    receipt = w3.eth.get_transaction_receipt(tx_hash)
                except Exception:
                    receipt = None
                if receipt is not None:
                    if receipt.status != 1:
                        raise PublisherError(f"Interrupted transaction reverted: {tx_hash}")
                    entry["status"] = "confirmed"
                    entry["blockNumber"] = receipt.blockNumber
                    continue
            metric_id, day_text = key.rsplit(":", 1)
            probe = MetricReading(
                path=Path("<ledger>"),
                metric_id=metric_id,
                day_key=int(day_text),
                market_day_start_utc=0,
                market_day_end_utc=0,
                value=int(entry["value"]),
                source_hash=normalize_hash(entry["sourceHash"]),
            )
            current = chain_reading(contract, probe)
            if current and current["value"] == probe.value:
                entry.update(ledger_entry_from_chain(probe, current, entry))
                continue
            nonce = int(entry["nonce"])
            if pending_nonce <= nonce:
                print(
                    f"RESOLVED {key}: nonce {nonce} was never broadcast (wallet's pending "
                    f"nonce is {pending_nonce}); removing the stale 'submitted' ledger row "
                    "so it resubmits with a fresh nonce. See shared/publish-spec.md §2.6.",
                    file=sys.stderr,
                )
                del ledger[key]
                continue
            raise PublisherError(
                f"{key}: an interrupted transaction may still be in flight; stop and inspect nonce {nonce}."
            )
        except PublisherError:
            raise
        except Exception as exc:
            raise PublisherError(
                f"{key}: malformed ledger entry ({type(exc).__name__}: {exc}); "
                "refusing to guess and continue."
            ) from exc
    save_ledger(ledger)


def append_log(log_path: Path, reading: MetricReading, tx_hash: str, outcome: str) -> None:
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(
            f"{utc_now()} {reading.metric_id} {reading.day_key} {reading.value} "
            f"{tx_hash} {outcome}\n"
        )


def send_reading(
    w3: Web3,
    contract,
    account,
    reading: MetricReading,
    nonce: int,
    ledger: dict[str, dict[str, Any]],
    log_path: Path,
    selectors: dict[str, str],
) -> tuple[int, int]:
    function = contract.functions.submitReading(
        reading.metric_hash,
        reading.day_key,
        reading.market_day_start_utc,
        reading.market_day_end_utc,
        reading.value,
        HexBytes("0x" + reading.source_hash),
    )
    base = {"from": account.address, "nonce": nonce, "chainId": EXPECTED_CHAIN_ID}
    try:
        estimated_gas = function.estimate_gas({"from": account.address})
        gas_price = w3.eth.gas_price
    except Exception as exc:
        classification = classify_revert(exc, selectors)
        if classification.is_expected:
            current = chain_reading(contract, reading)
            if current is not None:
                ledger[reading.ledger_key] = ledger_entry_from_chain(
                    reading, current, ledger.get(reading.ledger_key)
                )
                save_ledger(ledger)
            append_log(log_path, reading, "", "EXPECTED_ALREADY_FINALIZED")
            print(
                f"EXPECTED_ALREADY_FINALIZED {reading.ledger_key} "
                "(finalized before submission)"
            )
            return 0, nonce
        detail = classification.error_name or f"unrecognized revert ({type(exc).__name__})"
        raise PublisherError(
            f"{reading.ledger_key}: {detail} during gas estimation; aborting."
        ) from exc
    gas_limit = max(int(estimated_gas * 1.2), estimated_gas + 10_000)
    ledger[reading.ledger_key] = submitted_entry(reading, nonce)
    save_ledger(ledger)

    def broadcast(target_nonce: int, price: int):
        tx = function.build_transaction(
            {**base, "nonce": target_nonce, "gas": gas_limit, "gasPrice": price}
        )
        signed = account.sign_transaction(tx)
        return w3.eth.send_raw_transaction(signed.raw_transaction)

    last_hash = ""
    for attempt in range(MAX_GAS_BUMPS + 1):
        bumped_price = int(gas_price * (1.125**attempt)) + attempt
        try:
            tx_hash = broadcast(nonce, bumped_price)
        except ValueError as exc:
            message = str(exc).lower()
            if "nonce too low" not in message or attempt != 0:
                raise PublisherError(
                    f"{reading.ledger_key}: transaction send failed; aborting safely."
                ) from exc
            # §2.8: a stale local nonce is a transient hiccup, not grounds to abort
            # a whole run — re-sync from chain and retry exactly once.
            fresh_nonce = w3.eth.get_transaction_count(account.address, "pending")
            if fresh_nonce == nonce:
                raise PublisherError(
                    f"{reading.ledger_key}: transaction send failed; aborting safely."
                ) from exc
            print(
                f"{reading.ledger_key}: nonce too low (local {nonce}, chain {fresh_nonce}); "
                "re-syncing and retrying once.",
                file=sys.stderr,
            )
            nonce = fresh_nonce
            ledger[reading.ledger_key]["nonce"] = nonce
            save_ledger(ledger)
            try:
                tx_hash = broadcast(nonce, bumped_price)
            except ValueError as retry_exc:
                raise PublisherError(
                    f"{reading.ledger_key}: transaction send failed after nonce resync; "
                    "aborting safely."
                ) from retry_exc
        last_hash = "0x" + tx_hash.hex().removeprefix("0x")
        ledger[reading.ledger_key]["txHash"] = last_hash
        save_ledger(ledger)
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
            append_log(log_path, reading, last_hash, "UNEXPECTED_TIMEOUT")
            raise PublisherError(
                f"{reading.ledger_key}: still pending after two gas bumps; aborting."
            )
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
                current = chain_reading(contract, reading)
                if current is not None:
                    ledger[reading.ledger_key] = ledger_entry_from_chain(
                        reading, current, ledger.get(reading.ledger_key)
                    )
                else:
                    ledger[reading.ledger_key]["status"] = "finalized"
                    ledger[reading.ledger_key]["blockNumber"] = receipt.blockNumber
                save_ledger(ledger)
                append_log(log_path, reading, last_hash, "EXPECTED_ALREADY_FINALIZED")
                return receipt.gasUsed * bumped_price, nonce + 1
            append_log(log_path, reading, last_hash, "UNEXPECTED_REVERT")
            detail = classification.error_name or "unrecognized revert"
            raise PublisherError(
                f"{reading.ledger_key}: mined transaction reverted unexpectedly ({detail}); aborting."
            )
        ledger[reading.ledger_key].update(
            {
                "status": "confirmed",
                "txHash": last_hash,
                "blockNumber": receipt.blockNumber,
            }
        )
        save_ledger(ledger)
        append_log(log_path, reading, last_hash, "CONFIRMED")
        print(f"CONFIRMED {reading.ledger_key} {last_hash}")
        return receipt.gasUsed * bumped_price, nonce + 1
    raise AssertionError("unreachable")


def print_plan(plan: Plan, invalid: list[str]) -> None:
    print("GRIDFLEX publish plan")
    print(f"  Readings to submit:              {len(plan.submit)}")
    print(f"  Already published (skipped):    {plan.already_published}")
    print(f"  Already finalized (skipped):    {plan.already_finalized}")
    print(f"  Source-hash drift (safe skip):  {plan.hash_drift}")
    print(f"  Invalid files (skipped):        {len(invalid)}")
    for failure in invalid:
        print(f"  INVALID {failure}", file=sys.stderr)


def live_banner(
    chain_id: int, oracle: str, signer: str, balance: int, count: int, gas_price: int
) -> None:
    estimated_seconds = count * 1.5
    estimated_cost_wei = count * 220_000 * gas_price
    print("\nGRIDFLEX publish.py — LIVE MODE\n")
    print(f"  Chain ID:           {chain_id}")
    print(f"  Oracle contract:    {oracle}")
    print(f"  Signer (reporter):  {signer}")
    print(f"  Wallet balance:     {Web3.from_wei(balance, 'ether'):.6f} OKB")
    print(f"  Readings to submit: {count}")
    print(f"  Estimated duration: ~{max(1, round(estimated_seconds / 60))} minutes")
    print(f"  Estimated cost:     ~{Web3.from_wei(estimated_cost_wei, 'ether'):.6f} OKB")


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
    parser.add_argument("--reconcile", action="store_true")
    return parser


def validate_args(args: argparse.Namespace) -> None:
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
    try:
        validate_args(args)
        _, oracle_address = load_deployment()
        ledger = load_ledger()
        rpc_url = os.environ.get("XLAYER_RPC_URL", DEFAULT_RPC_URL)

        if args.check:
            account = load_reporter_account()
            w3 = make_web3(rpc_url)
            contract = load_contract(w3, oracle_address)
            chain_id, balance = preflight(w3, contract, account)
            print("GRIDFLEX reporter preflight: PASS")
            print(f"  Chain ID:          {chain_id}")
            print(f"  Oracle contract:   {oracle_address}")
            print(f"  Signer (reporter): {account.address}")
            print(f"  Wallet balance:    {Web3.from_wei(balance, 'ether'):.6f} OKB")
            return 0

        readings, invalid = collect_readings(args)

        if not args.live and has_pending_submitted_entries(ledger):
            # §2.6: resolve on startup, "before doing anything else" — including a
            # dry run, since a "submitted" row from a crashed prior run otherwise
            # gets misreported as brand-new work. Gated on has_pending_submitted_entries()
            # so a clean ledger (the common case) still needs no key or RPC at all.
            print(
                "A previous run left submitted-but-unconfirmed readings; resolving "
                "against chain before reporting an accurate plan.",
                file=sys.stderr,
            )
            w3 = make_web3(rpc_url)
            contract = load_contract(w3, oracle_address)
            account = load_reporter_account()
            recover_submitted_entries(w3, contract, account, ledger)

        plan = plan_from_ledger(readings, ledger)

        if args.reconcile:
            w3 = make_web3(rpc_url)
            contract = load_contract(w3, oracle_address)
            if w3.eth.chain_id != EXPECTED_CHAIN_ID:
                raise PublisherError("Reconciliation is pointed at the wrong chain.")
            reconcile(contract, ledger)
            if not args.live:
                return 1 if invalid else 0

        if not args.live:
            if args.limit is not None:
                plan.submit = plan.submit[: args.limit]
            print_plan(plan, invalid)
            estimated_cost = len(plan.submit) * 220_000 * 20_000_000
            print(f"  Estimated duration:             ~{max(1, round(len(plan.submit) * 1.5 / 60))} minutes")
            print(f"  Estimated cost:                 ~{Web3.from_wei(estimated_cost, 'ether'):.6f} OKB")
            print("\nDRY RUN ONLY — no transactions were sent.")
            return 1 if invalid else 0

        account = load_reporter_account()
        w3 = make_web3(rpc_url)
        contract = load_contract(w3, oracle_address)
        selectors = build_error_selectors(contract.abi)
        chain_id, balance = preflight(w3, contract, account)
        recover_submitted_entries(w3, contract, account, ledger)
        plan = plan_from_ledger(readings, ledger)
        plan = protect_against_stale_ledger(contract, plan, ledger, args.limit)
        print_plan(plan, invalid)
        if invalid:
            raise PublisherError("Live publication refused because metric validation failed.")
        if not plan.submit:
            print("Nothing to submit. No transactions were sent.")
            return 0
        gas_price = w3.eth.gas_price
        live_banner(chain_id, oracle_address, account.address, balance, len(plan.submit), gas_price)
        if input('\nType "yes" to continue: ').strip() != "yes":
            print("Cancelled. No transactions were sent.")
            return 0

        nonce = w3.eth.get_transaction_count(account.address, "pending")
        total_gas_cost = 0
        submitted = 0
        failed = 0
        abort_message: str | None = None
        log_path = LOGS_DIR / datetime.now(timezone.utc).strftime("publish-%Y%m%dT%H%M%SZ.log")
        for reading in plan.submit:
            try:
                cost, nonce = send_reading(
                    w3, contract, account, reading, nonce, ledger, log_path, selectors
                )
            except PublisherError as exc:
                failed += 1
                abort_message = str(exc)
                break
            except Exception as exc:
                # §2.8: a transport failure (a dropped RPC connection, a socket
                # timeout) inside send_reading is not a PublisherError, but must
                # still abort and report through the same UNEXPECTED path as any
                # other failure, not escape past the summary uncaught.
                failed += 1
                abort_message = f"{type(exc).__name__}: {exc}"
                break
            total_gas_cost += cost
            submitted += 1

        elapsed = int(time.monotonic() - started)
        print("\nGRIDFLEX publish summary")
        print(f"  Submitted:                       {submitted}")
        print(f"  Already published (skipped):    {plan.already_published}")
        print(f"  Already finalized (skipped):    {plan.already_finalized}")
        print(f"  Invalid files (skipped):        {len(invalid)}")
        print(f"  Failed (UNEXPECTED):            {failed}")
        print(f"  Wall-clock time:                {elapsed // 60:02d}:{elapsed % 60:02d}")
        print(f"  Total gas spent:                {Web3.from_wei(total_gas_cost, 'ether'):.6f} OKB")
        print(f"  Ledger updated:                 {LEDGER_PATH}")
        if abort_message is not None:
            print(f"ERROR: {abort_message}", file=sys.stderr)
        return 1 if (failed or invalid) else 0
    except (PublisherError, KeyboardInterrupt) as exc:
        message = "Interrupted by operator." if isinstance(exc, KeyboardInterrupt) else str(exc)
        print(f"ERROR: {message}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
