#!/usr/bin/env python3
"""Return the pool's collateral from settled GRIDFLEX markets to its provider.

    python3 claim_liquidity.py          dry run: lists every market and what a claim would pay
    python3 claim_liquidity.py --live   sends claimLiquidity() after a typed "yes"

Every market is seeded with 10,000 mUSDT of initial liquidity (10,000 YES and
10,000 NO in the pool). When the market resolves, the pool's winning reserve
is worth 1 mUSDT per token and the losing reserve is worth nothing; when it
cancels, each reserve is worth 0.5 per token. BinaryMarket.claimLiquidity()
burns the pool's tokens and pays that amount to the provider, once, and only
the provider can call it. Nothing else releases it: a resolved market that
nobody claims keeps that collateral forever.

Same conventions as resolve_markets.py:
- Reads the market list from shared/addresses.json and every fact about a
  market from the chain, not from the file.
- Dry run by default. The signer is loaded only with --live, after the plan
  is printed, using the finalizer-key convention (FINALIZER_KEYSTORE_PATH or
  FINALIZER_PRIVATE_KEY). The key is never printed or logged.
- Chain guard: refuses unless shared/addresses.json and the RPC both report
  X Layer testnet (chain 1952).
- Only markets whose provider is the signer are sent; the others are listed
  and left alone. One typed "yes" covers the run, and each transaction hash
  is written to logs/ before its receipt is awaited.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from hexbytes import HexBytes
from web3 import Web3

from create_markets import ADDRESSES_PATH, load_abi, load_addresses, send_tx
from finalize import load_finalizer_account
from publish import DEFAULT_RPC_URL, LOGS_DIR, PublisherError, load_json, make_web3
from resolve_markets import chain_guard

EXPLORER_TX_URL = "https://www.oklink.com/x-layer-testnet/tx/"

STATUS_OPEN = "open"
STATUS_CLAIMABLE = "claimable"
STATUS_CLAIMED = "already_claimed"
STATUS_TEXT = {
    STATUS_OPEN: "not settled yet; nothing to claim",
    STATUS_CLAIMABLE: "settled; the provider can claim",
    STATUS_CLAIMED: "already claimed",
}


@dataclass(frozen=True)
class PoolState:
    address: str
    day_key: int
    threshold: int
    provider: str
    resolved: bool
    cancelled: bool
    yes_won: bool
    liquidity_redeemed: bool
    yes_reserve: int
    no_reserve: int

    @property
    def status(self) -> str:
        if self.liquidity_redeemed:
            return STATUS_CLAIMED
        if self.resolved or self.cancelled:
            return STATUS_CLAIMABLE
        return STATUS_OPEN

    @property
    def payout(self) -> int:
        """What claimLiquidity() pays now, mirroring the contract's rule."""
        if self.liquidity_redeemed or not (self.resolved or self.cancelled):
            return 0
        if self.cancelled:
            return (self.yes_reserve + self.no_reserve) // 2
        return self.yes_reserve if self.yes_won else self.no_reserve


def musdt(units: int) -> str:
    return f"{Decimal(units) / Decimal(10**6):,.6f} mUSDT"


def read_pool(w3: Web3, address: str, binary_market_abi: Any) -> PoolState:
    market = w3.eth.contract(address=address, abi=binary_market_abi)
    f = market.functions
    return PoolState(
        address=address,
        day_key=int(f.dayKey().call()),
        threshold=int(f.threshold().call()),
        provider=Web3.to_checksum_address(f.liquidityProvider().call()),
        resolved=bool(f.resolved().call()),
        cancelled=bool(f.cancelled().call()),
        yes_won=bool(f.yesWon().call()),
        liquidity_redeemed=bool(f.liquidityRedeemed().call()),
        yes_reserve=int(f.yesReserve().call()),
        no_reserve=int(f.noReserve().call()),
    )


def list_pools(w3: Web3) -> list[PoolState]:
    config = load_json(ADDRESSES_PATH)
    abi = load_abi("BinaryMarket")
    pools = []
    for entry in config.get("markets", []):
        pools.append(read_pool(w3, Web3.to_checksum_address(entry["market"]), abi))
    return pools


def describe(pool: PoolState) -> str:
    outcome = "cancelled" if pool.cancelled else ("YES" if pool.yes_won else "NO") if pool.resolved else "open"
    return (
        f"  {pool.address}  day {pool.day_key}  strike {pool.threshold / 100:.2f}  "
        f"{outcome:<9}  pool {musdt(pool.yes_reserve)} YES / {musdt(pool.no_reserve)} NO  "
        f"-> {STATUS_TEXT[pool.status]}"
        + (f", pays {musdt(pool.payout)}" if pool.status == STATUS_CLAIMABLE else "")
        + f"  provider {pool.provider}"
    )


def claimable_for(pools: list[PoolState], signer: str) -> list[PoolState]:
    return [p for p in pools if p.status == STATUS_CLAIMABLE and p.provider.lower() == signer.lower()]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--live", action="store_true", help="send claimLiquidity() transactions (asks first)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        addresses = load_addresses()
        w3 = make_web3(os.environ.get("XLAYER_RPC_URL", DEFAULT_RPC_URL))
        chain_guard(w3)
        pools = list_pools(w3)

        print("GRIDFLEX claim_liquidity plan")
        print(f"  Chain: X Layer testnet ({addresses['chainId']}), {len(pools)} listed markets\n")
        for pool in pools:
            print(describe(pool))
        claimable = [p for p in pools if p.status == STATUS_CLAIMABLE]
        print(f"\n  {len(claimable)} claimable, {musdt(sum(p.payout for p in claimable))} in total")

        if not args.live:
            print("\nDRY RUN ONLY - no key was loaded and no transaction was sent.")
            return 0

        account = load_finalizer_account()
        mine = claimable_for(pools, account.address)
        print(f"\n  Signer: {account.address}")
        if not mine:
            print("  Nothing claimable belongs to this signer. No transaction was sent.")
            return 0
        for pool in mine:
            print(f"    will claim {musdt(pool.payout)} from {pool.address}")
        if input('\nType "yes" to send: ').strip() != "yes":
            print("Cancelled. No transaction was sent.")
            return 0

        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        log_path = LOGS_DIR / datetime.now(timezone.utc).strftime("claim-liquidity-%Y%m%dT%H%M%SZ.log")
        abi = load_abi("BinaryMarket")
        for pool in mine:
            market = w3.eth.contract(address=pool.address, abi=abi)
            receipt, _ = send_tx(
                w3, account, market.functions.claimLiquidity(), f"claimLiquidity {pool.address}", log_path
            )
            tx_hash = "0x" + HexBytes(receipt.transactionHash).hex().removeprefix("0x")
            print(f"CLAIMED {musdt(pool.payout)} from {pool.address}")
            print(f"  {EXPLORER_TX_URL}{tx_hash}")
        return 0
    except (PublisherError, KeyboardInterrupt) as exc:
        message = "Interrupted by operator." if isinstance(exc, KeyboardInterrupt) else str(exc)
        print(f"ERROR: {message}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
