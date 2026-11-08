#!/usr/bin/env python3
"""The reviewed deployment pins (shared/pins.json) and the oracle identity
check every chain script runs before it reads a key.

shared/pins.json lives on main only and changes only through a reviewed
pull request: ops/code-matches-main.sh treats it as code, so the data
branch can never change it. shared/addresses.json, which the data branch
does change (it appends the markets it creates), must agree with the pins
on every core address: assert_addresses_match_pins() is called by every
loader (create_markets.load_addresses, publish.load_deployment), so the
check holds outside CI too.

oracle_identity() decides whether an address is the pinned GridOracleV2.
Before any key is read it requires, in order:

  - every v2 pin is set (they stay null until the oracle-v2 switch PR);
  - eth_chainId equals the pinned chain;
  - the address is the pinned oracleV2, and is not the first oracle (v1);
  - there is bytecode at the address (not an EOA, not undeployed), and its
    keccak256 equals the pinned oracleV2CodeHash;
  - guardian(), reporter() and owner() each return exactly one 32-byte
    word holding a non-zero address, equal to the pinned one.

Any RPC failure counts as a failed check: nothing is ever assumed.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from web3 import Web3

ROOT = Path(__file__).resolve().parent
PINS_PATH = ROOT / "shared" / "pins.json"

ZERO_ADDRESS = "0x" + "00" * 20
CODE_HASH_RE = re.compile(r"^0x[0-9a-f]{64}$")

PIN_KEYS = {
    "chainId", "oracleV1", "v1Reporter", "factory", "legacyFactories", "collateral",
    "metricIds", "oracleV2", "oracleV2CodeHash", "v2Reporter", "v2Guardian", "v2Owner",
    "settler",
}
# All set together by the oracle-v2 switch PR, or all null.
V2_KEYS = ("oracleV2", "oracleV2CodeHash", "v2Reporter", "v2Guardian", "v2Owner")
# Selectors are computed, never typed: guardian(), reporter(), owner().
ROLE_SELECTORS = {name: bytes(Web3.keccak(text=f"{name}()")[:4]) for name in ("guardian", "reporter", "owner")}


class PublisherError(RuntimeError):
    """A safe, user-facing failure. publish.py re-exports this class, so
    every chain script catches one type."""


class PinError(PublisherError):
    """shared/pins.json is missing or malformed, or a config disagrees with it."""


class OracleIdentityError(PublisherError):
    """The oracle is not the pinned GridOracleV2. The message always starts
    with ORACLE IDENTITY so the settle job treats it as a stop word."""

    def __init__(self, reason: str):
        super().__init__(f"ORACLE IDENTITY: {reason}; nothing was signed or sent.")


@dataclass(frozen=True)
class Pins:
    chain_id: int
    oracle_v1: str
    v1_reporter: str
    factory: str
    legacy_factories: tuple[str, ...]
    collateral: str
    metric_ids: tuple[str, ...]
    oracle_v2: str | None
    oracle_v2_code_hash: str | None
    v2_reporter: str | None
    v2_guardian: str | None
    v2_owner: str | None
    settler: str | None

    @property
    def v2_pinned(self) -> bool:
        return self.oracle_v2 is not None

    @property
    def active_oracle(self) -> str:
        """The oracle shared/addresses.json must name: v2 once it is pinned."""
        return self.oracle_v2 or self.oracle_v1

    @property
    def active_reporter(self) -> str:
        return self.v2_reporter if self.v2_pinned else self.v1_reporter

    def metric_hashes(self) -> dict[str, str]:
        """keccak256(name) hex (no 0x) -> name, as markets store metricId."""
        return {Web3.keccak(text=name).hex().removeprefix("0x"): name for name in self.metric_ids}


def _address(value: Any, field: str, path: Path, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not Web3.is_address(value):
        raise PinError(f"{path}: {field} must be an address, got {value!r}")
    # A mixed-case address must carry a valid checksum: a typo is refused, not normalised.
    if value != value.lower() and value != value.upper() and not Web3.is_checksum_address(value):
        raise PinError(f"{path}: {field} has a bad checksum: {value}")
    address = Web3.to_checksum_address(value)
    if address == Web3.to_checksum_address(ZERO_ADDRESS):
        raise PinError(f"{path}: {field} must not be the zero address")
    return address


def load_pins(path: Path | None = None) -> Pins:
    """shared/pins.json, strictly: exact keys, valid addresses, v2 all-or-nothing."""
    path = path or PINS_PATH
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise PinError(f"Required file is missing: {path}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise PinError(f"Invalid JSON in {path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise PinError(f"{path} must be a JSON object")
    keys = set(raw)
    if keys != PIN_KEYS:
        missing, extra = sorted(PIN_KEYS - keys), sorted(keys - PIN_KEYS)
        raise PinError(f"{path}: keys differ from the schema (missing {missing}, unknown {extra})")
    if type(raw["chainId"]) is not int or raw["chainId"] <= 0:
        raise PinError(f"{path}: chainId must be a positive integer")
    legacy = raw["legacyFactories"]
    if not isinstance(legacy, list):
        raise PinError(f"{path}: legacyFactories must be a list")
    metric_ids = raw["metricIds"]
    if (not isinstance(metric_ids, list) or not metric_ids
            or any(not isinstance(m, str) or not m for m in metric_ids)):
        raise PinError(f"{path}: metricIds must be a non-empty list of names")

    set_v2 = [k for k in V2_KEYS if raw[k] is not None]
    if set_v2 and len(set_v2) != len(V2_KEYS):
        raise PinError(f"{path}: the v2 pins are set together or not at all (set: {set_v2})")
    code_hash = raw["oracleV2CodeHash"]
    if code_hash is not None and (not isinstance(code_hash, str) or not CODE_HASH_RE.fullmatch(code_hash)):
        raise PinError(f"{path}: oracleV2CodeHash must be 0x + 64 lowercase hex characters")

    pins = Pins(
        chain_id=raw["chainId"],
        oracle_v1=_address(raw["oracleV1"], "oracleV1", path),
        v1_reporter=_address(raw["v1Reporter"], "v1Reporter", path),
        factory=_address(raw["factory"], "factory", path),
        legacy_factories=tuple(_address(a, "legacyFactories[]", path) for a in legacy),
        collateral=_address(raw["collateral"], "collateral", path),
        metric_ids=tuple(metric_ids),
        oracle_v2=_address(raw["oracleV2"], "oracleV2", path, nullable=True),
        oracle_v2_code_hash=code_hash,
        v2_reporter=_address(raw["v2Reporter"], "v2Reporter", path, nullable=True),
        v2_guardian=_address(raw["v2Guardian"], "v2Guardian", path, nullable=True),
        v2_owner=_address(raw["v2Owner"], "v2Owner", path, nullable=True),
        settler=_address(raw["settler"], "settler", path, nullable=True),
    )
    if pins.oracle_v2 is not None and pins.oracle_v2 == pins.oracle_v1:
        raise PinError(f"{path}: oracleV2 must differ from oracleV1")
    return pins


def assert_addresses_match_pins(chain_id: int, oracle: str, factory: str | None = None,
                                collateral: str | None = None,
                                legacy_factories: list[str] | None = None,
                                pins: Pins | None = None) -> Pins:
    """Refuse a shared/addresses.json whose core addresses are not the pinned
    ones. Every argument left as None is not compared."""
    pins = pins or load_pins()
    problems = []
    if chain_id != pins.chain_id:
        problems.append(f"chainId {chain_id} != pinned {pins.chain_id}")
    if Web3.to_checksum_address(oracle) != pins.active_oracle:
        problems.append(f"GridOracle {oracle} != pinned {pins.active_oracle}")
    if factory is not None and Web3.to_checksum_address(factory) != pins.factory:
        problems.append(f"MarketFactory {factory} != pinned {pins.factory}")
    if collateral is not None and Web3.to_checksum_address(collateral) != pins.collateral:
        problems.append(f"MockUSDT {collateral} != pinned {pins.collateral}")
    if legacy_factories is not None and tuple(
            Web3.to_checksum_address(a) for a in legacy_factories) != pins.legacy_factories:
        problems.append(f"legacy factories {legacy_factories} != pinned {list(pins.legacy_factories)}")
    if problems:
        raise PinError("shared/addresses.json disagrees with the reviewed shared/pins.json: "
                       + "; ".join(problems) + ". Change core addresses through a reviewed pull request to main.")
    return pins


def decode_address_word(raw: Any, name: str) -> str:
    """One ABI-encoded address return value, strictly: exactly 32 bytes, the
    top 12 zero, the address non-zero. Anything else (empty return from an
    EOA or a fallback, a revert payload, a wider type) is refused."""
    data = bytes(raw) if raw is not None else b""
    if len(data) != 32:
        raise OracleIdentityError(f"{name}() returned {len(data)} bytes, not one 32-byte word")
    if any(data[:12]):
        raise OracleIdentityError(f"{name}() returned a word that is not an address")
    address = Web3.to_checksum_address(data[12:])
    if address == Web3.to_checksum_address(ZERO_ADDRESS):
        raise OracleIdentityError(f"{name}() is the zero address")
    return address


def oracle_identity(w3: Web3, oracle: str, pins: Pins | None = None,
                    block: int | str = "latest") -> dict[str, Any]:
    """The pinned GridOracleV2's identity, or OracleIdentityError. Read-only."""
    try:
        pins = pins or load_pins()
    except PinError as exc:
        raise OracleIdentityError(f"pins unreadable ({exc})") from exc
    if not pins.v2_pinned:
        raise OracleIdentityError("shared/pins.json has no GridOracleV2 pinned (oracleV2 and its "
                                  "identity are null until the switch PR)")
    try:
        address = Web3.to_checksum_address(oracle)
    except (TypeError, ValueError) as exc:
        raise OracleIdentityError(f"{oracle!r} is not an address") from exc
    if address == pins.oracle_v1:
        raise OracleIdentityError(f"{address} is the first GridOracle (v1), whose reporter can never be replaced")
    if address != pins.oracle_v2:
        raise OracleIdentityError(f"{address} is not the pinned GridOracleV2 {pins.oracle_v2}")
    try:
        chain_id = int(w3.eth.chain_id)
        code = bytes(w3.eth.get_code(address, block_identifier=block))
    except Exception as exc:  # RPC errors arrive as many types
        raise OracleIdentityError(f"could not read the chain ({type(exc).__name__})") from exc
    if chain_id != pins.chain_id:
        raise OracleIdentityError(f"chain {chain_id} is not the pinned chain {pins.chain_id}")
    if not code:
        raise OracleIdentityError(f"no bytecode at {address} (an EOA or not deployed)")
    code_hash = "0x" + bytes(Web3.keccak(code)).hex()
    if code_hash != pins.oracle_v2_code_hash:
        raise OracleIdentityError(f"bytecode hash {code_hash} != pinned {pins.oracle_v2_code_hash}")
    expected = {"guardian": pins.v2_guardian, "reporter": pins.v2_reporter, "owner": pins.v2_owner}
    roles = {}
    for name, selector in ROLE_SELECTORS.items():
        try:
            raw = w3.eth.call({"to": address, "data": "0x" + selector.hex()}, block)
        except Exception as exc:
            raise OracleIdentityError(f"{name}() could not be read ({type(exc).__name__})") from exc
        roles[name] = decode_address_word(raw, name)
        if roles[name] != expected[name]:
            raise OracleIdentityError(f"{name}() is {roles[name]}, pinned {expected[name]}")
    return {"oracle": address, "chainId": chain_id, "codeHash": code_hash, **roles}


def assert_signer(identity: dict[str, Any], signer: str) -> None:
    """After a key is decrypted and before anything is sent: the key must be
    the oracle's reporter."""
    if Web3.to_checksum_address(signer) != identity["reporter"]:
        raise OracleIdentityError(f"the decrypted key {signer} is not reporter() {identity['reporter']}")
