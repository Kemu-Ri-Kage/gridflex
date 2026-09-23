"""Send test OKB from the deployer to a fresh demo-recording wallet.

The demo video is recorded with a new account, so every wallet prompt a
first-time trader sees appears on camera (shared/demo-video-script.md). That
account needs test OKB for gas and nothing else: test mUSDT comes from the
site's own "Get 1,000 demo mUSDT" button, which calls MockUSDT.mint - open to
any account - on camera.

    python3 fund_demo_wallet.py --to 0xNEW          dry run: checks, plan, no key
    python3 fund_demo_wallet.py --to 0xNEW --live   sends after a typed "yes"

Same conventions as create_markets.py:
- Dry run by default. The key is loaded only with --live, after every
  read-only check has passed, and is never printed or logged; only the
  sender's address is.
- Chain guard: refuses unless both shared/addresses.json and the RPC report
  X Layer testnet (chain 1952), before anything else is read.
- A typed "yes" before the one transaction is sent, and the transaction hash
  is written to logs/ before its receipt is awaited.

Refuses a recipient that isn't a fresh externally owned account the video can
use: a contract, the zero address, or any address recorded in
shared/addresses.json (the deployer, the reporter, a contract, a market or a
token). A recipient that has already sent a transaction or holds mUSDT is
not refused - it may be a rehearsal account - but the plan says it is not
fresh, because the video needs one that is. The amount is capped at
MAX_OKB - thousands of times what the demo's gas costs, and still small -
so a typo can't drain the deployer, whose OKB also pays for creating
markets.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from web3 import Web3
from web3.exceptions import TimeExhausted

from create_markets import ADDRESSES_PATH, load_abi, load_addresses, utc_now
from finalize import load_finalizer_account
from publish import (
    DEFAULT_RPC_URL,
    EXPECTED_CHAIN_ID,
    LOGS_DIR,
    PublisherError,
    load_json,
    make_web3,
)

DEFAULT_OKB = Decimal("0.01")
MAX_OKB = Decimal("0.05")
TRANSFER_GAS = 21_000
RECEIPT_TIMEOUT_SECONDS = 90
EXPLORER_TX_URL = "https://www.oklink.com/x-layer-testnet/tx/"

# The 13 transactions the demo wallet sends on camera, with the gas each one
# used: measured from the receipts in shared/demo-evidence.md where one
# exists, otherwise the maximum in `forge test --gas-report` (mintSet,
# resolve and redeem, the worst case over every test path).
DEMO_TRANSACTIONS: tuple[tuple[str, int], ...] = (
    ("Get 1,000 demo mUSDT (MockUSDT.mint)", 51_285),
    ("2 Oct buy: approve mUSDT", 46_683),
    ("2 Oct buy: mintSet", 160_458),
    ("2 Oct buy: approve NO", 46_347),
    ("2 Oct buy: swap", 72_880),
    ("Switch position: approve YES", 46_347),
    ("Switch position: swap", 72_880),
    ("Replay buy: approve mUSDT", 46_683),
    ("Replay buy: mintSet", 160_458),
    ("Replay buy: approve NO", 46_347),
    ("Replay buy: swap", 72_880),
    ("Replay: resolve", 62_073),
    ("Replay: redeem", 78_425),
)


def demo_gas_total() -> int:
    return sum(gas for _, gas in DEMO_TRANSACTIONS)


def parse_okb(text: str) -> int:
    """Whole OKB as text -> wei, refusing anything outside (0, MAX_OKB]."""
    try:
        amount = Decimal(text)
    except InvalidOperation as exc:
        raise PublisherError(f"--okb {text!r} is not a number.") from exc
    if not amount.is_finite() or amount <= 0:
        raise PublisherError("--okb must be more than 0.")
    if amount > MAX_OKB:
        raise PublisherError(
            f"--okb {amount} is over the {MAX_OKB} OKB cap; the demo spends well under "
            f"0.001 OKB, and the deployer's OKB also pays for creating markets."
        )
    return int(amount * 10**18)


def known_addresses(config: Any) -> set[str]:
    """Every address recorded anywhere in shared/addresses.json, lowercased."""
    found: set[str] = set()

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, str) and Web3.is_address(value):
            found.add(value.lower())

    walk(config)
    return found


def check_recipient(w3: Web3, recipient_text: str, known: set[str]) -> str:
    """Checksummed recipient, or PublisherError if it can't be the demo wallet."""
    if not Web3.is_address(recipient_text):
        raise PublisherError(f"--to {recipient_text!r} is not an address.")
    recipient = Web3.to_checksum_address(recipient_text)
    if int(recipient, 16) == 0:
        raise PublisherError("--to is the zero address.")
    if recipient.lower() in known:
        raise PublisherError(
            f"--to {recipient} is recorded in {ADDRESSES_PATH.name} (the deployer, the "
            "reporter, a contract, a market or a token), not a fresh demo wallet."
        )
    if len(w3.eth.get_code(recipient)) > 0:
        raise PublisherError(f"--to {recipient} is a contract, not a wallet.")
    return recipient


def chain_guard(w3: Web3) -> None:
    try:
        chain_id = w3.eth.chain_id
    except Exception as exc:
        raise PublisherError(f"RPC preflight failed: {type(exc).__name__}") from exc
    if chain_id != EXPECTED_CHAIN_ID:
        raise PublisherError(
            f"RPC reports chain {chain_id}; expected X Layer testnet {EXPECTED_CHAIN_ID}. "
            "Nothing was read or sent."
        )


def okb(wei: int) -> str:
    return f"{Decimal(wei) / Decimal(10**18):.6f} OKB"


def musdt(units: int) -> str:
    return f"{Decimal(units) / Decimal(10**6):,.2f} mUSDT"


def print_plan(
    recipient: str, amount_wei: int, gas_price: int, balance: int, nonce: int,
    musdt_balance: int,
) -> None:
    demo_cost = demo_gas_total() * gas_price
    print("GRIDFLEX fund_demo_wallet plan")
    print(f"  Chain:               X Layer testnet ({EXPECTED_CHAIN_ID})")
    print(f"  Recipient:           {recipient}")
    print(f"    OKB now:           {okb(balance)}")
    print(f"    mUSDT now:         {musdt(musdt_balance)}")
    print(f"    Transactions sent: {nonce}")
    fresh = nonce == 0 and musdt_balance == 0
    print(
        "    Fresh:             "
        + ("yes" if fresh else "NO - it has sent transactions or holds mUSDT; "
           "the video needs an account that has done neither")
    )
    print(f"  Send:                {okb(amount_wei)}")
    print(f"  Gas price now:       {Decimal(gas_price) / Decimal(10**9):.4f} gwei")
    print(f"  Demo's 13 transactions, worst case: {demo_gas_total():,} gas = {okb(demo_cost)}")
    if demo_cost:
        print(f"  Headroom:            {(balance + amount_wei) // demo_cost:,}x the demo's gas")


def send_transfer(w3: Web3, account, recipient: str, amount_wei: int, gas_price: int) -> str:
    nonce = w3.eth.get_transaction_count(account.address, "pending")
    tx = {
        "to": recipient,
        "value": amount_wei,
        "nonce": nonce,
        "chainId": EXPECTED_CHAIN_ID,
        "gas": TRANSFER_GAS,
        "gasPrice": gas_price,
    }
    signed = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    hex_hash = "0x" + tx_hash.hex().removeprefix("0x")
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOGS_DIR / datetime.now(timezone.utc).strftime("fund-demo-wallet-%Y%m%dT%H%M%SZ.log")
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(f"{utc_now()} fund {recipient} {amount_wei} {hex_hash} SENT\n")
    try:
        receipt = w3.eth.wait_for_transaction_receipt(
            tx_hash, timeout=RECEIPT_TIMEOUT_SECONDS, poll_latency=1
        )
    except TimeExhausted as exc:
        raise PublisherError(
            f"{hex_hash} still pending after {RECEIPT_TIMEOUT_SECONDS}s; check it on OKLink "
            "before sending again."
        ) from exc
    outcome = "CONFIRMED" if receipt.status == 1 else "REVERTED"
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(f"{utc_now()} fund {recipient} {amount_wei} {hex_hash} {outcome}\n")
    if receipt.status != 1:
        raise PublisherError(f"Transfer {hex_hash} reverted.")
    return hex_hash


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Send test OKB from the deployer to a fresh demo-recording wallet."
    )
    parser.add_argument("--to", required=True, help="the fresh demo wallet's address")
    parser.add_argument(
        "--okb", default=str(DEFAULT_OKB),
        help=f"whole OKB to send (default {DEFAULT_OKB}, at most {MAX_OKB})",
    )
    parser.add_argument("--live", action="store_true", help="send, after a typed yes")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        amount_wei = parse_okb(args.okb)
        addresses = load_addresses()  # refuses a config that isn't chain 1952
        w3 = make_web3(os.environ.get("XLAYER_RPC_URL", DEFAULT_RPC_URL))
        chain_guard(w3)

        recipient = check_recipient(w3, args.to, known_addresses(load_json(ADDRESSES_PATH)))
        collateral = w3.eth.contract(address=addresses["collateral"], abi=load_abi("MockUSDT"))
        gas_price = w3.eth.gas_price
        print_plan(
            recipient, amount_wei, gas_price,
            balance=w3.eth.get_balance(recipient),
            nonce=w3.eth.get_transaction_count(recipient),
            musdt_balance=collateral.functions.balanceOf(recipient).call(),
        )

        if not args.live:
            print("\nDRY RUN ONLY - no key was loaded and no transaction was sent.")
            return 0

        account = load_finalizer_account()
        if account.address.lower() == recipient.lower():
            raise PublisherError("--to is the signer's own address.")
        sender_balance = w3.eth.get_balance(account.address)
        needed = amount_wei + TRANSFER_GAS * gas_price
        print(f"\n  Sender (finalizer):  {account.address}")
        print(f"    OKB now:           {okb(sender_balance)}")
        if sender_balance < needed:
            raise PublisherError(
                f"Sender holds {okb(sender_balance)}; sending needs {okb(needed)} with gas."
            )
        if input('\nType "yes" to send: ').strip() != "yes":
            print("Cancelled. No transaction was sent.")
            return 0

        tx_hash = send_transfer(w3, account, recipient, amount_wei, gas_price)
        print(f"\nSENT {okb(amount_wei)} to {recipient}")
        print(f"  {EXPLORER_TX_URL}{tx_hash}")
        print(f"  Recipient now holds {okb(w3.eth.get_balance(recipient))}")
        return 0
    except (PublisherError, KeyboardInterrupt) as exc:
        message = "Interrupted by operator." if isinstance(exc, KeyboardInterrupt) else str(exc)
        print(f"ERROR: {message}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
