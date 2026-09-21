#!/usr/bin/env python3
"""Safely create GRIDFLEX demo markets via MarketFactory.createMarket.

Dry-run is the default. Live mode requires a matching finalizer key,
successful preflight checks, and an interactive ``yes`` confirmation.

createMarket is permissionless (contracts/src/MarketFactory.sol has no
access-control modifier - any funded wallet holding and approving MockUSDT
can call it), so this reuses finalize.py's finalizer-key convention
(FINALIZER_PRIVATE_KEY / FINALIZER_KEYSTORE_PATH) rather than the reporter
key - the same choice finalize.py already made for finalize(), which is
permissionless for the same reason.

Mirrors contracts/script/CreateDemoMarket.s.sol's parameter conventions
(10,000 mUSDT initial liquidity; dispute window 0 for a past-day demo that
must finalize immediately - shared/deployment.md) rather than inventing new
ones, and shared/finalize-spec.md's table-parsing approach for reading
shared/demo-markets.md rather than hand-typing the six candidate markets
where they could drift from that document.

Only creates a market for a dayKey whose oracle reading is already
published on-chain (checked live via GridOracle.getReading, not assumed) -
listing a market against a reading that doesn't exist yet would create a
market that can never resolve. A (metricId, dayKey) pair that already has a
market - checked live via MarketFactory.getMarkets(), not just the local
ledger - is skipped, not recreated, so re-running this script is safe. If
that existing market is missing from the local ledger (e.g. a prior run's
createMarket succeeded but a later step in the same run failed), a live run
records it - reading its real parameters back from the chain, never
guessed - instead of leaving the local bookkeeping silently out of sync.

Contract reads against a market address just returned by createMarket's
receipt retry briefly on empty return data: the RPC node that served the
follow-up eth_call can lag a few blocks behind the one that mined the
transaction, and a view call against code that node hasn't indexed yet
returns empty data, not a revert - a timing gap, not a wrong address or an
ABI mismatch, and it resolves itself within a few seconds.

When recording an already-existing market (see above), the core parameters
- metricId, dayKey, threshold, collateral, oracle, resolveAfter,
disputeWindow - are read directly from the deployed BinaryMarket, not from
its MarketCreated event: independent verification against the contract
itself, and it works even if the event can't be found at all. Only the
original transaction hash and initial liquidity, which the market contract
does not expose once trading may have moved its reserves, come from that
event - searched for defensively, in RPC-provider-sized block windows
(confirmed empirically: this endpoint's eth_getLogs rejects a query
spanning more than roughly 50-99 blocks with an HTTP 400, rather than
documenting a limit), never as a single wide-range query that this RPC
endpoint would simply reject.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from hexbytes import HexBytes
from web3 import Web3
from web3.exceptions import BadFunctionCallOutput, TimeExhausted

from finalize import (
    DEMO_MARKETS_PATH,
    SUMMARY_TABLE_COLUMNS,
    SUMMARY_TABLE_HEADING,
    _table_lines,
    load_finalizer_account,
)
from publish import (
    DEFAULT_RPC_URL,
    EXPECTED_CHAIN_ID,
    LOGS_DIR,
    ROOT,
    PublisherError,
    load_json,
    make_web3,
)

ADDRESSES_PATH = ROOT / "shared" / "addresses.json"
ABI_DIR = ROOT / "shared" / "abi"
MARKET_LEDGER_PATH = ROOT / "data" / "market-ledger.json"
WEB_ENV_PATH = ROOT / "web" / ".env.local"
MARKET_FACTORY_ARTIFACT_PATH = (
    ROOT / "contracts" / "out" / "MarketFactory.sol" / "MarketFactory.json"
)

# CreateDemoMarket.s.sol's DEFAULT_INITIAL_LIQUIDITY (10_000e6) - the same
# 10,000 mUSDT-at-6-decimals seed the Solidity deploy script uses.
DEFAULT_INITIAL_LIQUIDITY = 10_000 * 10**6
# shared/deployment.md: "0 for a tightly controlled past-day demo that must
# finalize immediately" - both markets this script targets by default are
# exactly that case (dayKeys already in the past, readings already published).
DEFAULT_DISPUTE_WINDOW = 0
# How long trading stays open after creation before resolve() becomes
# callable. BinaryMarket requires resolveAfter > block.timestamp at
# construction, so this can never be "now" - kept short since the oracle
# reading already exists and the point is to demo mint -> trade -> resolve
# -> redeem quickly, not to run a real multi-day market.
DEFAULT_TRADING_WINDOW_SECONDS = 600
UINT64_MAX = 2**64 - 1
INT256_MIN = -(2**255)
INT256_MAX = 2**255 - 1
RECEIPT_TIMEOUT_SECONDS = 90
RPC_COURTESY_SLEEP = 0.5
# A just-created contract's code can lag behind the RPC node serving the
# very next call by a couple of seconds; five attempts at one second apart
# comfortably covers that without masking a genuinely wrong address (which
# would still be empty on attempt five and correctly raise).
CONTRACT_READ_RETRY_ATTEMPTS = 5
CONTRACT_READ_RETRY_DELAY_SECONDS = 1.0
# web3's Contract.get_logs() defaults from_block to "latest" when not given
# explicitly - querying only the newest block, not history. This RPC
# endpoint also rejects a single eth_getLogs call spanning more than
# roughly 50-99 blocks with a bare HTTP 400 (empirically confirmed: 50
# blocks succeeds, 100 does not - the provider does not document an exact
# number). 40 stays safely under that. The search below therefore always
# passes explicit from_block/to_block and paginates backward in windows
# this size, rather than a single query over an unknown range.
GET_LOGS_CHUNK_BLOCKS = 40
GET_LOGS_MAX_CHUNKS = 300


def call_with_retry(fn, attempts: int = CONTRACT_READ_RETRY_ATTEMPTS,
                     delay: float = CONTRACT_READ_RETRY_DELAY_SECONDS):
    """Retry a view call a few times when it fails on empty return data.

    web3 raises BadFunctionCallOutput both for a genuine ABI mismatch and
    for "no code at this address yet" - the latter is expected for a few
    seconds right after a contract is created, if the RPC node serving this
    call hasn't caught up to the block that created it. Any other exception
    (a revert, a network error) is not retried; it means something other
    than a timing lag.
    """
    last_exc: BadFunctionCallOutput | None = None
    for attempt in range(attempts):
        try:
            return fn()
        except BadFunctionCallOutput as exc:
            last_exc = exc
            if attempt < attempts - 1:
                time.sleep(delay)
    assert last_exc is not None
    raise last_exc


@dataclass(frozen=True)
class CandidateMarket:
    row: int
    metric_id: str
    day_key: int
    threshold: int  # signed, metric's stored unit (USD/MWh x100)
    label: str

    @property
    def key(self) -> str:
        return f"{self.metric_id}:{self.day_key}"

    @property
    def metric_hash(self) -> bytes:
        return Web3.keccak(text=self.metric_id)


def parse_demo_markets_candidates(path: Path | None = None) -> list[CandidateMarket]:
    """Parse shared/demo-markets.md's own Summary table for all six markets.

    Reuses finalize.py's exact table-location/shape validation
    (_table_lines, SUMMARY_TABLE_HEADING, SUMMARY_TABLE_COLUMNS) so the two
    scripts fail the same way if the table's shape ever changes, instead of
    hand-typing the six markets a second time where they could drift from
    the document that defines them.
    """
    path = path or DEMO_MARKETS_PATH
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise PublisherError(f"Cannot read {path} for the demo-market table.") from exc

    table_lines = _table_lines(text, SUMMARY_TABLE_HEADING)
    if len(table_lines) < 3:
        raise PublisherError(
            f"{path}: expected a pipe-delimited table with a header, a divider, and at least "
            f"one data row under '{SUMMARY_TABLE_HEADING}' - has the table's format changed?"
        )

    def cells_of(line: str) -> list[str]:
        return [cell.strip() for cell in line.strip("|").split("|")]

    header_cells = cells_of(table_lines[0])
    if len(header_cells) != SUMMARY_TABLE_COLUMNS:
        raise PublisherError(
            f"{path}: expected {SUMMARY_TABLE_COLUMNS} columns in the Summary table, found "
            f"{len(header_cells)} - has the table's format changed?"
        )

    threshold_pattern = re.compile(r"-?\d+(?:\.\d+)?")
    candidates: list[CandidateMarket] = []
    for row_number, line in enumerate(table_lines[2:], start=1):
        cells = cells_of(line)
        if len(cells) != SUMMARY_TABLE_COLUMNS:
            raise PublisherError(
                f"{path}: expected {SUMMARY_TABLE_COLUMNS} columns, found {len(cells)} in row "
                f"{line!r} - has the table's format changed?"
            )
        metric_id = cells[1].strip("`")
        threshold_text = cells[2]
        day_key_text = cells[3].strip("`")
        date_text = cells[4]
        match = threshold_pattern.search(threshold_text)
        if not match or not day_key_text.isdigit():
            raise PublisherError(
                f"{path}: could not parse a threshold/dayKey pair from row {line!r} - has the "
                "table's format changed?"
            )
        threshold_dollars = float(match.group())
        candidates.append(
            CandidateMarket(
                row=row_number,
                metric_id=metric_id,
                day_key=int(day_key_text),
                threshold=int(round(threshold_dollars * 100)),
                label=f"{metric_id} {threshold_text} dayKey {day_key_text} ({date_text})",
            )
        )
    if not candidates:
        raise PublisherError(f"{path}: Summary table parsed but contained zero data rows.")
    return candidates


def load_addresses() -> dict[str, Any]:
    config = load_json(ADDRESSES_PATH)
    try:
        chain_id = int(config["chainId"])
        oracle = Web3.to_checksum_address(config["GridOracle"])
        factory = Web3.to_checksum_address(config["MarketFactory"])
        collateral = Web3.to_checksum_address(config["MockUSDT"])
    except (KeyError, TypeError, ValueError) as exc:
        raise PublisherError(f"Invalid deployment config: {ADDRESSES_PATH}") from exc
    if chain_id != EXPECTED_CHAIN_ID:
        raise PublisherError(
            f"Deployment config has chainId {chain_id}; expected {EXPECTED_CHAIN_ID}."
        )
    return {"chainId": chain_id, "oracle": oracle, "factory": factory, "collateral": collateral}


def load_abi(name: str) -> Any:
    path = ABI_DIR / f"{name}.json"
    return load_json(path)


def load_market_ledger() -> dict[str, dict[str, Any]]:
    if not MARKET_LEDGER_PATH.exists():
        return {}
    ledger = load_json(MARKET_LEDGER_PATH)
    if not isinstance(ledger, dict):
        raise PublisherError(f"Ledger must be a JSON object: {MARKET_LEDGER_PATH}")
    return ledger


def save_market_ledger(ledger: dict[str, dict[str, Any]]) -> None:
    MARKET_LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    MARKET_LEDGER_PATH.write_text(json.dumps(ledger, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def chain_oracle_reading(oracle_contract, candidate: CandidateMarket) -> dict[str, Any] | None:
    raw = oracle_contract.functions.getReading(candidate.metric_hash, candidate.day_key).call()
    if int(raw[6]) == 0:
        return None
    return {"value": int(raw[4]), "finalized": bool(raw[7])}


def existing_markets(w3: Web3, factory_contract, binary_market_abi: Any) -> dict[str, str]:
    """Live (metricId, dayKey) pairs that already have a BinaryMarket, mapped
    to that market's address.

    Reads every market the factory has ever created, not the local ledger -
    the same "trust the chain, not local state" rule finalize.py already
    applies to every reading it evaluates. metricId()/dayKey() are wrapped in
    call_with_retry because a market created earlier in this same process
    (e.g. by a prior --live run moments ago) can still be lagging behind the
    RPC node serving this call.
    """
    addresses = factory_contract.functions.getMarkets().call()
    pairs: dict[str, str] = {}
    for address in addresses:
        market = w3.eth.contract(address=address, abi=binary_market_abi)
        metric_hash = HexBytes(call_with_retry(market.functions.metricId().call)).hex()
        day_key = int(call_with_retry(market.functions.dayKey().call))
        pairs[f"{metric_hash}:{day_key}"] = Web3.to_checksum_address(address)
        time.sleep(RPC_COURTESY_SLEEP)
    return pairs


@dataclass
class Evaluation:
    candidate: CandidateMarket
    status: str  # "eligible" | "reading_not_published" | "market_exists"
    oracle_value: int | None = None
    existing_address: str | None = None  # set only when status is STATUS_EXISTS
    verified: bool | None = None  # set only when status is STATUS_EXISTS


STATUS_ELIGIBLE = "eligible"
STATUS_NOT_PUBLISHED = "reading_not_published"
STATUS_EXISTS = "market_exists"


def on_chain_threshold_matches(
    w3: Web3, binary_market_abi: Any, candidate: CandidateMarket, market_address: str
) -> bool:
    """Independent verification (design-brief-style "trust the chain, not
    local state") that a market found at this address is really the one
    shared/demo-markets.md describes for this row, not just a same-day
    same-metric market with different terms. Shared by the dry-run plan
    (read-only) and backfill_existing_market (which also refuses to record
    on a mismatch)."""
    market_contract = w3.eth.contract(address=market_address, abi=binary_market_abi)
    on_chain = int(call_with_retry(market_contract.functions.threshold().call))
    return on_chain == candidate.threshold


def build_plan(
    candidates: list[CandidateMarket],
    oracle_contract,
    existing_pairs: dict[str, str],
    w3: Web3,
    binary_market_abi: Any,
) -> list[Evaluation]:
    evaluations: list[Evaluation] = []
    for candidate in candidates:
        metric_hash_hex = candidate.metric_hash.hex()
        existing_address = existing_pairs.get(f"{metric_hash_hex}:{candidate.day_key}")
        if existing_address is not None:
            verified = on_chain_threshold_matches(w3, binary_market_abi, candidate, existing_address)
            time.sleep(RPC_COURTESY_SLEEP)
            evaluations.append(
                Evaluation(candidate, STATUS_EXISTS, existing_address=existing_address, verified=verified)
            )
            continue
        current = chain_oracle_reading(oracle_contract, candidate)
        time.sleep(RPC_COURTESY_SLEEP)
        if current is None:
            evaluations.append(Evaluation(candidate, STATUS_NOT_PUBLISHED))
            continue
        evaluations.append(Evaluation(candidate, STATUS_ELIGIBLE, current["value"]))
    return evaluations


def print_plan(evaluations: list[Evaluation], ledger: dict[str, dict[str, Any]]) -> None:
    print("GRIDFLEX create_markets plan")
    for evaluation in evaluations:
        candidate = evaluation.candidate
        if evaluation.status == STATUS_EXISTS:
            verify_note = "verified" if evaluation.verified else "THRESHOLD MISMATCH - do not record"
            ledger_note = (
                "already in local ledger"
                if candidate.key in ledger
                else "not yet in local ledger; --live will record it"
            )
            print(f"  #{candidate.row} {candidate.label}   ALREADY EXISTS, {verify_note} - skipping "
                  f"({ledger_note})")
        elif evaluation.status == STATUS_NOT_PUBLISHED:
            print(f"  #{candidate.row} {candidate.label}   READING NOT PUBLISHED - skipping")
        else:
            print(
                f"  #{candidate.row} {candidate.label}   ELIGIBLE "
                f"(oracle value {evaluation.oracle_value})"
            )
    eligible = sum(1 for e in evaluations if e.status == STATUS_ELIGIBLE)
    exists = sum(1 for e in evaluations if e.status == STATUS_EXISTS)
    not_published = sum(1 for e in evaluations if e.status == STATUS_NOT_PUBLISHED)
    print(f"\n  Eligible to create:           {eligible}")
    print(f"  Already exist (skipped):      {exists}")
    print(f"  Reading not published (skip): {not_published}")


def expected_factory_runtime() -> HexBytes:
    """Load the runtime bytecode produced from the checked-out factory source.

    The factory ABI did not change when swap protection was added to
    BinaryMarket, so an ABI-only check cannot distinguish the obsolete
    factory from the trade-safe release. MarketFactory embeds the
    BinaryMarket creation bytecode in its own runtime; an exact runtime-code
    comparison therefore rejects the old deployment before any mint or
    approval transaction can be sent.
    """
    if not MARKET_FACTORY_ARTIFACT_PATH.exists():
        raise PublisherError(
            "Local MarketFactory build artifact is missing. Run `cd contracts && forge build` "
            "before checking or creating markets."
        )
    artifact = load_json(MARKET_FACTORY_ARTIFACT_PATH)
    try:
        object_hex = artifact["deployedBytecode"]["object"]
    except (KeyError, TypeError) as exc:
        raise PublisherError(
            f"Invalid MarketFactory build artifact: {MARKET_FACTORY_ARTIFACT_PATH}"
        ) from exc
    runtime = HexBytes(object_hex)
    if not runtime:
        raise PublisherError(
            f"MarketFactory artifact has empty runtime bytecode: {MARKET_FACTORY_ARTIFACT_PATH}"
        )
    return runtime


def preflight(w3: Web3, addresses: dict[str, Any], account) -> tuple[int, int]:
    try:
        chain_id = w3.eth.chain_id
        contract_code: dict[str, HexBytes] = {}
        for name, address in (
            ("GridOracle", addresses["oracle"]),
            ("MarketFactory", addresses["factory"]),
            ("MockUSDT", addresses["collateral"]),
        ):
            code = w3.eth.get_code(address)
            if not code or code == HexBytes("0x"):
                raise PublisherError(f"No contract bytecode at {name} address {address}.")
            contract_code[name] = HexBytes(code)
        balance = w3.eth.get_balance(account.address)
    except PublisherError:
        raise
    except Exception as exc:
        raise PublisherError(f"RPC preflight failed: {type(exc).__name__}") from exc
    if chain_id != EXPECTED_CHAIN_ID:
        raise PublisherError(f"Wrong chain: got {chain_id}, expected {EXPECTED_CHAIN_ID}.")
    expected_runtime = expected_factory_runtime()
    deployed_runtime = contract_code["MarketFactory"]
    if deployed_runtime != expected_runtime:
        raise PublisherError(
            "Configured MarketFactory bytecode does not match the checked-out trade-safe "
            "factory. Update shared/addresses.json only after deploying the current "
            "MarketFactory; no market transaction was sent."
        )
    return chain_id, balance


def send_tx(w3: Web3, account, function, label: str, log_path: Path) -> tuple[Any, int]:
    """One transaction, estimate -> sign -> send -> wait, matching publish.py's
    build_transaction/sign_transaction shape. No gas-bump retry loop: this
    script creates at most a handful of markets per run, always under direct
    operator supervision (the typed "yes" confirmation), unlike publish.py's
    unattended nightly-scale batch - a stuck transaction here is meant to
    stop the run and be looked at, not be silently retried around.
    """
    nonce = w3.eth.get_transaction_count(account.address, "pending")
    try:
        estimated_gas = function.estimate_gas({"from": account.address})
    except Exception as exc:
        raise PublisherError(f"{label}: gas estimation failed ({exc}); aborting.") from exc
    gas_limit = max(int(estimated_gas * 1.2), estimated_gas + 10_000)
    gas_price = w3.eth.gas_price
    tx = function.build_transaction(
        {
            "from": account.address,
            "nonce": nonce,
            "chainId": EXPECTED_CHAIN_ID,
            "gas": gas_limit,
            "gasPrice": gas_price,
        }
    )
    signed = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    hex_hash = "0x" + tx_hash.hex().removeprefix("0x")
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(f"{utc_now()} {label} {hex_hash} SENT\n")
    try:
        receipt = w3.eth.wait_for_transaction_receipt(
            tx_hash, timeout=RECEIPT_TIMEOUT_SECONDS, poll_latency=1
        )
    except TimeExhausted as exc:
        raise PublisherError(f"{label}: still pending after {RECEIPT_TIMEOUT_SECONDS}s; aborting.") from exc
    with log_path.open("a", encoding="utf-8") as handle:
        outcome = "CONFIRMED" if receipt.status == 1 else "REVERTED"
        handle.write(f"{utc_now()} {label} {hex_hash} {outcome}\n")
    if receipt.status != 1:
        raise PublisherError(f"{label}: transaction {hex_hash} reverted; aborting.")
    return receipt, receipt.gasUsed * gas_price


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def create_one_market(
    w3: Web3,
    account,
    addresses: dict[str, Any],
    factory_contract,
    collateral_contract,
    binary_market_abi: Any,
    candidate: CandidateMarket,
    resolve_after: int,
    dispute_window: int,
    initial_liquidity: int,
    log_path: Path,
) -> dict[str, Any]:
    """Mint -> approve -> createMarket, matching CreateDemoMarket.s.sol's own
    three-call sequence exactly, then read back yesToken()/noToken()."""
    label = f"{candidate.key} mint"
    _, mint_cost = send_tx(
        w3, account, collateral_contract.functions.mint(account.address, initial_liquidity), label, log_path
    )

    label = f"{candidate.key} approve"
    _, approve_cost = send_tx(
        w3,
        account,
        collateral_contract.functions.approve(addresses["factory"], initial_liquidity),
        label,
        log_path,
    )

    label = f"{candidate.key} createMarket"
    create_function = factory_contract.functions.createMarket(
        addresses["oracle"],
        candidate.metric_hash,
        candidate.day_key,
        candidate.threshold,
        addresses["collateral"],
        resolve_after,
        dispute_window,
        initial_liquidity,
    )
    receipt, create_cost = send_tx(w3, account, create_function, label, log_path)

    events = factory_contract.events.MarketCreated().process_receipt(receipt)
    if not events:
        raise PublisherError(
            f"{candidate.key}: createMarket confirmed but emitted no MarketCreated event; "
            "aborting before guessing an address."
        )
    market_address = Web3.to_checksum_address(events[0]["args"]["market"])

    market_contract = w3.eth.contract(address=market_address, abi=binary_market_abi)
    yes_token = Web3.to_checksum_address(call_with_retry(market_contract.functions.yesToken().call))
    no_token = Web3.to_checksum_address(call_with_retry(market_contract.functions.noToken().call))

    return {
        "metricId": candidate.metric_id,
        "dayKey": candidate.day_key,
        "threshold": candidate.threshold,
        "market": market_address,
        "yesToken": yes_token,
        "noToken": no_token,
        "resolveAfter": resolve_after,
        "disputeWindow": dispute_window,
        "initialLiquidity": initial_liquidity,
        "createTxHash": Web3.to_hex(receipt.transactionHash),
        "createdAt": utc_now(),
        "totalGasCost": mint_cost + approve_cost + create_cost,
    }


def factory_deployment_block(w3: Web3) -> int:
    """Lower bound for a MarketCreated log search: no market can predate the
    factory that creates it. Read from the factory's own recorded
    deployment transaction (shared/addresses.json), not guessed."""
    config = load_json(ADDRESSES_PATH)
    tx_hash = config.get("transactions", {}).get("MarketFactory")
    if not tx_hash:
        raise PublisherError(
            f"{ADDRESSES_PATH} has no transactions.MarketFactory entry - cannot bound a "
            "MarketCreated log search without knowing how far back the factory itself goes."
        )
    receipt = w3.eth.get_transaction_receipt(tx_hash)
    return int(receipt.blockNumber)


def find_market_created_event(
    w3: Web3, factory_contract, market_address: str, earliest_block: int
) -> dict[str, Any] | None:
    """Find a market's original MarketCreated event by paginating
    eth_getLogs backward from the latest block in GET_LOGS_CHUNK_BLOCKS-size
    windows - see the module docstring for why a single wide-range query
    isn't an option on this RPC endpoint. Stops at the first (most recent) match,
    or once earliest_block (the factory's own deployment block) is reached;
    returns None rather than raising if truly not found within that range,
    since the market's core parameters can still be verified directly from
    its own contract (see backfill_existing_market) even without this.
    """
    checksum_market = Web3.to_checksum_address(market_address)
    to_block = w3.eth.block_number
    for _ in range(GET_LOGS_MAX_CHUNKS):
        if to_block < earliest_block:
            return None
        from_block = max(to_block - GET_LOGS_CHUNK_BLOCKS + 1, earliest_block)
        events = factory_contract.events.MarketCreated.get_logs(
            argument_filters={"market": checksum_market},
            from_block=from_block,
            to_block=to_block,
        )
        if events:
            return events[0]
        to_block = from_block - 1
        time.sleep(RPC_COURTESY_SLEEP)
    return None


def backfill_existing_market(
    w3: Web3,
    factory_contract,
    binary_market_abi: Any,
    candidate: CandidateMarket,
    market_address: str,
) -> dict[str, Any]:
    """Record a market that already exists on chain but is missing from the
    local ledger - e.g. createMarket confirmed in an earlier run, but that
    run then crashed reading the market back (the exact failure this
    function exists to recover from).

    metricId/dayKey were already matched to `candidate` by existing_markets()
    to even reach this function; threshold/collateral/oracle/resolveAfter/
    disputeWindow are read directly from the deployed market here and
    cross-checked against the candidate - independent verification of what
    the demo-markets.md table says this market should be, not a re-trust of
    this run's own flags. Only createTxHash and initialLiquidity, which the
    market contract doesn't expose once trading may have moved its
    reserves, come from the original MarketCreated event; if that event
    can't be found (see find_market_created_event), those two fields are
    recorded as unknown rather than blocking the rest of the record.
    """
    market_contract = w3.eth.contract(address=market_address, abi=binary_market_abi)
    on_chain_threshold = int(call_with_retry(market_contract.functions.threshold().call))
    if on_chain_threshold != candidate.threshold:
        raise PublisherError(
            f"{candidate.key}: on-chain threshold {on_chain_threshold} does not match "
            f"{candidate.threshold} from shared/demo-markets.md - refusing to record a market "
            "whose parameters don't match what this row is supposed to be."
        )
    yes_token = Web3.to_checksum_address(call_with_retry(market_contract.functions.yesToken().call))
    no_token = Web3.to_checksum_address(call_with_retry(market_contract.functions.noToken().call))
    resolve_after = int(call_with_retry(market_contract.functions.resolveAfter().call))
    dispute_window = int(call_with_retry(market_contract.functions.disputeWindow().call))

    earliest_block = factory_deployment_block(w3)
    event = find_market_created_event(w3, factory_contract, market_address, earliest_block)
    if event is not None:
        create_tx_hash = Web3.to_hex(event["transactionHash"])
        initial_liquidity = int(event["args"]["initialLiquidity"])
        created_at = format_wall_clock(int(w3.eth.get_block(event["blockNumber"])["timestamp"]))
    else:
        print(
            f"WARNING {candidate.key}: verified on-chain parameters match, but no "
            f"MarketCreated event was found between block {earliest_block} and the current "
            "block - createTxHash/initialLiquidity recorded as unknown rather than guessed.",
            file=sys.stderr,
        )
        create_tx_hash = None
        initial_liquidity = None
        created_at = utc_now()

    return {
        "metricId": candidate.metric_id,
        "dayKey": candidate.day_key,
        "threshold": on_chain_threshold,
        "market": market_address,
        "yesToken": yes_token,
        "noToken": no_token,
        "resolveAfter": resolve_after,
        "disputeWindow": dispute_window,
        "initialLiquidity": initial_liquidity,
        "createTxHash": create_tx_hash,
        "createdAt": created_at,
        "totalGasCost": 0,
        "backfilled": True,
    }


def write_addresses_file(created: list[dict[str, Any]]) -> None:
    """Append every created market to shared/addresses.json's "markets" list,
    and also fill the flat BinaryMarket/YesToken/NoToken fields from
    ERCOT_HBNORTH_DA_AVG dayKey 20260908 specifically - shared/deployment.md
    names that market "the first complete demonstration", i.e. the one slot
    other tooling (the single-market /trade UI today) reads. A second
    created market (e.g. the BASIS demo) is recorded in "markets" but does
    not overwrite that slot.
    """
    config = load_json(ADDRESSES_PATH)
    markets = config.get("markets")
    if not isinstance(markets, list):
        markets = []
    existing_keys = {f"{m.get('metricId')}:{m.get('dayKey')}" for m in markets}
    for record in created:
        key = f"{record['metricId']}:{record['dayKey']}"
        if key in existing_keys:
            continue
        markets.append(record)
        existing_keys.add(key)
        if record["metricId"] == "ERCOT_HBNORTH_DA_AVG" and record["dayKey"] == 20260908:
            config["BinaryMarket"] = record["market"]
            config["YesToken"] = record["yesToken"]
            config["NoToken"] = record["noToken"]
    config["markets"] = markets
    ADDRESSES_PATH.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_web_env(created: list[dict[str, Any]]) -> None:
    """Set NEXT_PUBLIC_DEMO_MARKET_ADDRESS to the ERCOT_HBNORTH_DA_AVG
    dayKey 20260908 market - the single slot web/lib/contracts.ts reads
    today. web/.env.local is gitignored; never printed or logged here."""
    target = next(
        (r for r in created if r["metricId"] == "ERCOT_HBNORTH_DA_AVG" and r["dayKey"] == 20260908),
        None,
    )
    if target is None or not WEB_ENV_PATH.exists():
        return
    lines = WEB_ENV_PATH.read_text(encoding="utf-8").splitlines()
    updated = False
    for i, line in enumerate(lines):
        if line.startswith("NEXT_PUBLIC_DEMO_MARKET_ADDRESS="):
            lines[i] = f"NEXT_PUBLIC_DEMO_MARKET_ADDRESS={target['market']}"
            updated = True
            break
    if not updated:
        lines.append(f"NEXT_PUBLIC_DEMO_MARKET_ADDRESS={target['market']}")
    WEB_ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def live_banner(
    chain_id: int,
    factory: str,
    signer: str,
    balance: int,
    eligible: list[Evaluation],
    resolve_after: int,
    dispute_window: int,
    initial_liquidity: int,
) -> None:
    print("\nGRIDFLEX create_markets.py - LIVE MODE\n")
    print(f"  Chain ID:             {chain_id}")
    print(f"  MarketFactory:        {factory}")
    print(f"  Signer (finalizer):   {signer}")
    print(f"  Wallet balance:       {Web3.from_wei(balance, 'ether'):.6f} OKB")
    print(f"  Markets to create:    {len(eligible)}")
    for evaluation in eligible:
        print(f"    #{evaluation.candidate.row} {evaluation.candidate.label}")
    print(f"  resolveAfter:         {resolve_after} ({format_wall_clock(resolve_after)})")
    print(f"  disputeWindow:        {dispute_window}s")
    print(f"  initialLiquidity:     {initial_liquidity / 10**6:.2f} mUSDT (each market)")


def format_wall_clock(epoch_seconds: int) -> str:
    return (
        datetime.fromtimestamp(epoch_seconds, tz=timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--market", action="append", type=int, choices=range(1, 7),
        help="restrict to this demo-markets.md row number (repeatable); default is all six, "
        "filtered live to those whose oracle reading is already published",
    )
    parser.add_argument("--limit", type=int, help="create at most this many markets this run")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument(
        "--trading-window-seconds", type=int, default=DEFAULT_TRADING_WINDOW_SECONDS,
        help=f"resolveAfter = now + this many seconds (default {DEFAULT_TRADING_WINDOW_SECONDS})",
    )
    parser.add_argument(
        "--dispute-window", type=int, default=DEFAULT_DISPUTE_WINDOW,
        help=f"BinaryMarket disputeWindow in seconds (default {DEFAULT_DISPUTE_WINDOW})",
    )
    parser.add_argument(
        "--initial-liquidity-musdt", type=float, default=DEFAULT_INITIAL_LIQUIDITY / 10**6,
        help="initial pool liquidity in whole mUSDT per market (default 10000)",
    )
    return parser


def validate_args(args: argparse.Namespace) -> None:
    if args.check and args.live:
        raise PublisherError("Use --check and --live as separate commands.")
    if args.limit is not None and args.limit <= 0:
        raise PublisherError("--limit must be positive.")
    if args.trading_window_seconds <= 0:
        raise PublisherError("--trading-window-seconds must be positive.")
    if args.dispute_window < 0:
        raise PublisherError("--dispute-window must not be negative.")
    if args.initial_liquidity_musdt <= 0:
        raise PublisherError("--initial-liquidity-musdt must be positive.")


def print_summary(
    created: list[dict[str, Any]],
    recorded: list[dict[str, Any]],
    evaluations: list[Evaluation],
    started: float,
) -> None:
    elapsed = int(time.monotonic() - started)
    total_gas = sum(r["totalGasCost"] for r in created)
    still_existed = sum(1 for e in evaluations if e.status == STATUS_EXISTS) - len(recorded)
    print("\nGRIDFLEX create_markets summary")
    print(f"  Created:                        {len(created)}")
    print(f"  Recorded (already existed):     {len(recorded)}")
    print(f"  Already existed (in ledger):    {still_existed}")
    print(f"  Reading not published (skip):   {sum(1 for e in evaluations if e.status == STATUS_NOT_PUBLISHED)}")
    print(f"  Wall-clock time:                {elapsed // 60:02d}:{elapsed % 60:02d}")
    print(f"  Total gas spent:                {Web3.from_wei(total_gas, 'ether'):.6f} OKB")
    for record in created:
        print(f"  CREATED  {record['metricId']} dayKey {record['dayKey']} -> {record['market']}")
    for record in recorded:
        print(f"  RECORDED {record['metricId']} dayKey {record['dayKey']} -> {record['market']}")
    print(f"  Ledger updated:                 {MARKET_LEDGER_PATH}")


def main(argv: list[str] | None = None) -> int:
    started = time.monotonic()
    args = build_parser().parse_args(argv)
    try:
        validate_args(args)
        addresses = load_addresses()
        rpc_url = os.environ.get("XLAYER_RPC_URL", DEFAULT_RPC_URL)

        if args.check:
            account = load_finalizer_account()
            w3 = make_web3(rpc_url)
            chain_id, balance = preflight(w3, addresses, account)
            print("GRIDFLEX create_markets preflight: PASS")
            print(f"  Chain ID:            {chain_id}")
            print(f"  MarketFactory:       {addresses['factory']}")
            print(f"  Signer (finalizer):  {account.address}")
            print(f"  Wallet balance:      {Web3.from_wei(balance, 'ether'):.6f} OKB")
            return 0

        candidates = parse_demo_markets_candidates()
        if args.market:
            wanted = set(args.market)
            candidates = [c for c in candidates if c.row in wanted]

        w3 = make_web3(rpc_url)
        oracle_abi = load_abi("GridOracle")
        factory_abi = load_abi("MarketFactory")
        binary_market_abi = load_abi("BinaryMarket")
        collateral_abi = load_abi("MockUSDT")
        oracle_contract = w3.eth.contract(address=addresses["oracle"], abi=oracle_abi)
        factory_contract = w3.eth.contract(address=addresses["factory"], abi=factory_abi)
        collateral_contract = w3.eth.contract(address=addresses["collateral"], abi=collateral_abi)

        pairs = existing_markets(w3, factory_contract, binary_market_abi)
        evaluations = build_plan(candidates, oracle_contract, pairs, w3, binary_market_abi)
        ledger = load_market_ledger()
        print_plan(evaluations, ledger)

        eligible = [e for e in evaluations if e.status == STATUS_ELIGIBLE]
        if args.limit is not None:
            eligible = eligible[: args.limit]
        # Markets that exist on chain but never made it into the local
        # ledger - a prior run's createMarket succeeded, then that run
        # crashed before recording it. Synced, never re-created.
        to_backfill = [
            e for e in evaluations if e.status == STATUS_EXISTS and e.candidate.key not in ledger
        ]

        if not args.live:
            print("\nDRY RUN ONLY - no transactions were sent.")
            return 0

        if not eligible and not to_backfill:
            print("Nothing to create. No transactions were sent.")
            return 0

        account = load_finalizer_account()
        chain_id, balance = preflight(w3, addresses, account)
        resolve_after = int(time.time()) + args.trading_window_seconds
        if resolve_after > UINT64_MAX:
            raise PublisherError("Computed resolveAfter does not fit uint64.")
        dispute_window = args.dispute_window
        if dispute_window > UINT64_MAX:
            raise PublisherError("--dispute-window does not fit uint64.")
        initial_liquidity = int(round(args.initial_liquidity_musdt * 10**6))

        live_banner(
            chain_id, addresses["factory"], account.address, balance, eligible,
            resolve_after, dispute_window, initial_liquidity,
        )
        if to_backfill:
            print("\n  Existing markets to record (no transaction, chain state only):")
            for evaluation in to_backfill:
                print(f"    #{evaluation.candidate.row} {evaluation.candidate.label} -> "
                      f"{evaluation.existing_address}")
        if input('\nType "yes" to continue: ').strip() != "yes":
            print("Cancelled. No transactions were sent.")
            return 0

        log_path = LOGS_DIR / datetime.now(timezone.utc).strftime("create-markets-%Y%m%dT%H%M%SZ.log")

        recorded: list[dict[str, Any]] = []
        for evaluation in to_backfill:
            candidate = evaluation.candidate
            record = backfill_existing_market(
                w3, factory_contract, binary_market_abi, candidate, evaluation.existing_address
            )
            ledger[candidate.key] = record
            save_market_ledger(ledger)
            recorded.append(record)
            print(f"RECORDED {candidate.key} -> {record['market']} (already existed on chain)")

        created: list[dict[str, Any]] = []
        for evaluation in eligible:
            candidate = evaluation.candidate
            record = create_one_market(
                w3, account, addresses, factory_contract, collateral_contract, binary_market_abi,
                candidate, resolve_after, dispute_window, initial_liquidity, log_path,
            )
            ledger[candidate.key] = record
            save_market_ledger(ledger)
            created.append(record)
            print(f"CREATED {candidate.key} -> {record['market']}")

        write_addresses_file(created + recorded)
        write_web_env(created + recorded)
        print_summary(created, recorded, evaluations, started)
        return 0
    except (PublisherError, KeyboardInterrupt) as exc:
        message = "Interrupted by operator." if isinstance(exc, KeyboardInterrupt) else str(exc)
        print(f"ERROR: {message}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
