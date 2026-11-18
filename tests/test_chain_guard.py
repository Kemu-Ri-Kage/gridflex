"""chain_guard: the reviewed pins (shared/pins.json) and the GridOracleV2
identity check (audit findings S3 step 4 and S4). A fake Web3 stands in for
the chain, so every adversarial case is offline and deterministic."""

import json
import tempfile
import unittest
from pathlib import Path

import net_guard  # noqa: F401  (refuses non-localhost sockets)

from web3 import Web3

import chain_guard
from chain_guard import OracleIdentityError, PinError, PublisherError

ROOT = Path(__file__).resolve().parent.parent

V1 = "0x970cefFC0e75bCa245F3337715992ad520A4D561"
V2 = Web3.to_checksum_address("0x" + "c2" * 20)
REPORTER = Web3.to_checksum_address("0x" + "a1" * 20)
GUARDIAN = Web3.to_checksum_address("0x" + "a2" * 20)
OWNER = Web3.to_checksum_address("0x" + "a3" * 20)
CODE = bytes.fromhex("6080604052") + b"\x01" * 64
CODE_HASH = "0x" + bytes(Web3.keccak(CODE)).hex()


def word(address):
    return b"\x00" * 12 + bytes.fromhex(address[2:])


class FakeEth:
    def __init__(self, chain_id=1952, code=None, returns=None, fail=None):
        self.chain_id = chain_id
        self.code = code if code is not None else {V2: CODE}
        self.returns = returns if returns is not None else {
            "guardian": word(GUARDIAN), "reporter": word(REPORTER), "owner": word(OWNER)}
        self.fail = fail or set()
        self.calls = []

    def get_code(self, address, block_identifier="latest"):
        if "code" in self.fail:
            raise ConnectionError("rpc down")
        return self.code.get(address, b"")

    def call(self, tx, block="latest"):
        selector = bytes.fromhex(tx["data"][2:])
        name = {v: k for k, v in chain_guard.ROLE_SELECTORS.items()}[selector]
        self.calls.append(name)
        if name in self.fail:
            raise ValueError("execution reverted")
        return self.returns.get(name, b"")


class FakeW3:
    def __init__(self, **kwargs):
        self.eth = FakeEth(**kwargs)


def pins_dict(**overrides):
    base = json.loads((ROOT / "shared" / "pins.json").read_text())
    base.update({"oracleV2": V2, "oracleV2CodeHash": CODE_HASH, "v2Reporter": REPORTER,
                 "v2Guardian": GUARDIAN, "v2Owner": OWNER})
    base.update(overrides)
    return base


def pins_from(data):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "pins.json"
        path.write_text(json.dumps(data))
        return chain_guard.load_pins(path)


class TestOracleIdentity(unittest.TestCase):
    def identity(self, w3=None, oracle=V2, **pin_overrides):
        return chain_guard.oracle_identity(w3 or FakeW3(), oracle, pins_from(pins_dict(**pin_overrides)))

    def refused(self, pattern, **kwargs):
        with self.assertRaisesRegex(OracleIdentityError, pattern) as ctx:
            self.identity(**kwargs)
        self.assertTrue(str(ctx.exception).startswith("ORACLE IDENTITY"))
        self.assertIsInstance(ctx.exception, PublisherError)

    def test_the_pinned_v2_passes(self):
        identity = self.identity()
        self.assertEqual((identity["reporter"], identity["guardian"], identity["owner"]),
                         (REPORTER, GUARDIAN, OWNER))
        self.assertEqual(identity["codeHash"], CODE_HASH)

    def test_an_eoa_is_refused(self):
        # The baseline probe accepted the deployer EOA: eth_call to it returns 0x.
        self.refused("no bytecode", w3=FakeW3(code={}, returns={}))

    def test_wrong_bytecode_is_refused(self):
        self.refused("bytecode hash", w3=FakeW3(code={V2: CODE + b"\x00"}))

    def test_a_fallback_contract_without_guardian_is_refused(self):
        # A contract whose fallback answers every call with empty data.
        self.refused("guardian\\(\\) returned 0 bytes",
                     w3=FakeW3(returns={"reporter": word(REPORTER), "owner": word(OWNER)}))

    def test_guardian_reverting_is_refused(self):
        self.refused("guardian\\(\\) could not be read", w3=FakeW3(fail={"guardian"}))

    def test_guardian_zero_is_refused(self):
        self.refused("zero address", w3=FakeW3(returns={
            "guardian": b"\x00" * 32, "reporter": word(REPORTER), "owner": word(OWNER)}))

    def test_a_wider_word_is_refused(self):
        self.refused("not an address", w3=FakeW3(returns={
            "guardian": b"\x01" + word(GUARDIAN)[1:], "reporter": word(REPORTER), "owner": word(OWNER)}))

    def test_a_long_return_is_refused(self):
        self.refused("64 bytes", w3=FakeW3(returns={
            "guardian": word(GUARDIAN) * 2, "reporter": word(REPORTER), "owner": word(OWNER)}))

    def test_wrong_guardian_reporter_or_owner_is_refused(self):
        other = word("0x" + "ee" * 20)
        for role in ("guardian", "reporter", "owner"):
            returns = {"guardian": word(GUARDIAN), "reporter": word(REPORTER), "owner": word(OWNER)}
            returns[role] = other
            with self.subTest(role=role):
                self.refused(f"{role}\\(\\) is", w3=FakeW3(returns=returns))

    def test_the_v1_oracle_is_refused(self):
        self.refused("first GridOracle", oracle=V1)

    def test_an_unpinned_address_is_refused(self):
        self.refused("not the pinned GridOracleV2", oracle="0x" + "dE" * 20)

    def test_the_wrong_chain_is_refused(self):
        self.refused("chain 1", w3=FakeW3(chain_id=1))

    def test_unset_pins_are_refused_before_any_chain_read(self):
        w3 = FakeW3()
        with self.assertRaisesRegex(OracleIdentityError, "no GridOracleV2 pinned"):
            chain_guard.oracle_identity(w3, V2, chain_guard.load_pins())
        self.assertEqual(w3.eth.calls, [])

    def test_an_rpc_failure_is_a_refusal(self):
        self.refused("could not read the chain", w3=FakeW3(fail={"code"}))

    def test_the_signer_must_be_the_reporter(self):
        identity = self.identity()
        chain_guard.assert_signer(identity, REPORTER)
        with self.assertRaisesRegex(OracleIdentityError, "not reporter"):
            chain_guard.assert_signer(identity, GUARDIAN)


class TestPins(unittest.TestCase):
    def test_the_committed_pins_load_with_v2_unset(self):
        pins = chain_guard.load_pins()
        self.assertEqual(pins.chain_id, 1952)
        self.assertEqual(pins.oracle_v1, V1)
        self.assertFalse(pins.v2_pinned)
        self.assertEqual(pins.active_oracle, V1)

    def test_the_committed_pins_match_main_addresses(self):
        config = json.loads((ROOT / "shared" / "addresses.json").read_text())
        pins = chain_guard.load_pins()
        legacy = [e["address"] for e in config["legacyDeployments"]["MarketFactory"]]
        chain_guard.assert_addresses_match_pins(config["chainId"], config["GridOracle"],
                                                config["MarketFactory"], config["MockUSDT"], legacy, pins)
        self.assertEqual(pins.v1_reporter, Web3.to_checksum_address(config["reporter"]))

    def test_unknown_or_missing_keys_are_refused(self):
        with self.assertRaisesRegex(PinError, "unknown"):
            pins_from(pins_dict(extra=1))
        data = pins_dict()
        del data["settler"]
        with self.assertRaisesRegex(PinError, "missing"):
            pins_from(data)

    def test_v2_pins_are_all_or_nothing(self):
        with self.assertRaisesRegex(PinError, "together"):
            pins_from(pins_dict(v2Owner=None))

    def test_a_bad_checksum_or_zero_address_is_refused(self):
        with self.assertRaisesRegex(PinError, "checksum"):
            pins_from(pins_dict(factory="0xe52189873eb34A5cdbeE5ACAD2d227F2a65CC3A9"))
        with self.assertRaisesRegex(PinError, "zero"):
            pins_from(pins_dict(collateral="0x" + "00" * 20))

    def test_v2_equal_to_v1_is_refused(self):
        with self.assertRaisesRegex(PinError, "differ"):
            pins_from(pins_dict(oracleV2=V1))

    def test_a_missing_pins_file_fails_closed(self):
        with self.assertRaisesRegex(PinError, "missing"):
            chain_guard.load_pins(Path("/nonexistent/pins.json"))

    def test_a_foreign_oracle_factory_or_collateral_in_addresses_is_refused(self):
        pins = chain_guard.load_pins()
        evil = "0x" + "66" * 20
        for kwargs in ({"oracle": evil}, {"factory": evil}, {"collateral": evil}):
            args = {"chain_id": 1952, "oracle": V1, "factory": pins.factory,
                    "collateral": pins.collateral, **kwargs}
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(PinError, "disagrees"):
                chain_guard.assert_addresses_match_pins(pins=pins, **args)


class TestLoadersUsePins(unittest.TestCase):
    """Every loader refuses an addresses.json the pins disagree with, so the
    check applies outside CI too (S3 step 4)."""

    def write_config(self, directory, **overrides):
        config = json.loads((ROOT / "shared" / "addresses.json").read_text())
        config.update(overrides)
        path = Path(directory) / "addresses.json"
        path.write_text(json.dumps(config))
        return path

    def test_create_markets_and_publish_refuse_a_foreign_oracle(self):
        import create_markets
        import publish
        from unittest.mock import patch
        evil = Web3.to_checksum_address("0x" + "66" * 20)
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_config(directory, GridOracle=evil)
            with patch.object(create_markets, "ADDRESSES_PATH", path), \
                    self.assertRaisesRegex(PinError, "GridOracle"):
                create_markets.load_addresses()
            with patch.object(publish, "ADDRESSES_PATH", path), \
                    self.assertRaisesRegex(PinError, "GridOracle"):
                publish.load_deployment()

    def test_the_committed_addresses_load(self):
        import create_markets
        import publish
        self.assertEqual(create_markets.load_addresses()["oracle"], V1)
        self.assertEqual(publish.load_deployment()[1], V1)


if __name__ == "__main__":
    unittest.main()
