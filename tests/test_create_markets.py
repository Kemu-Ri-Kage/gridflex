import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from hexbytes import HexBytes

import create_markets
from publish import PublisherError


class TestFactoryCompatibilityGuard(unittest.TestCase):
    def test_loads_runtime_from_local_build_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "MarketFactory.json"
            artifact.write_text(
                json.dumps({"deployedBytecode": {"object": "0x6001600055"}}),
                encoding="utf-8",
            )
            with patch.object(create_markets, "MARKET_FACTORY_ARTIFACT_PATH", artifact):
                self.assertEqual(
                    create_markets.expected_factory_runtime(), HexBytes("0x6001600055")
                )

    def test_missing_artifact_stops_before_any_transaction(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing.json"
            with patch.object(create_markets, "MARKET_FACTORY_ARTIFACT_PATH", missing):
                with self.assertRaisesRegex(PublisherError, "forge build"):
                    create_markets.expected_factory_runtime()

    def test_preflight_rejects_obsolete_factory_runtime(self):
        w3 = MagicMock()
        w3.eth.chain_id = create_markets.EXPECTED_CHAIN_ID
        w3.eth.get_code.side_effect = [
            HexBytes("0x01"),
            HexBytes("0xdeadbeef"),
            HexBytes("0x02"),
        ]
        w3.eth.get_balance.return_value = 1
        addresses = {
            "oracle": "0x0000000000000000000000000000000000000001",
            "factory": "0x0000000000000000000000000000000000000002",
            "collateral": "0x0000000000000000000000000000000000000003",
        }
        account = SimpleNamespace(address="0x0000000000000000000000000000000000000004")

        with patch.object(
            create_markets, "expected_factory_runtime", return_value=HexBytes("0xcafebabe")
        ):
            with self.assertRaisesRegex(PublisherError, "does not match"):
                create_markets.preflight(w3, addresses, account)

    def test_preflight_accepts_exact_factory_runtime(self):
        expected = HexBytes("0xcafebabe")
        w3 = MagicMock()
        w3.eth.chain_id = create_markets.EXPECTED_CHAIN_ID
        w3.eth.get_code.side_effect = [HexBytes("0x01"), expected, HexBytes("0x02")]
        w3.eth.get_balance.return_value = 123
        addresses = {
            "oracle": "0x0000000000000000000000000000000000000001",
            "factory": "0x0000000000000000000000000000000000000002",
            "collateral": "0x0000000000000000000000000000000000000003",
        }
        account = SimpleNamespace(address="0x0000000000000000000000000000000000000004")

        with patch.object(create_markets, "expected_factory_runtime", return_value=expected):
            self.assertEqual(
                create_markets.preflight(w3, addresses, account),
                (create_markets.EXPECTED_CHAIN_ID, 123),
            )


if __name__ == "__main__":
    unittest.main()
