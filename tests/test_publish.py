import argparse
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from web3 import Web3
from web3.exceptions import ContractCustomError

import publish


class TestPublishValidation(unittest.TestCase):
    def test_loads_signed_basis_value(self):
        path = next(
            publish.METRICS_DIR.glob("ERCOT_WEST_NORTH_DA_BASIS__*.json")
        )
        reading = publish.load_reading(path)
        self.assertEqual(reading.metric_id, "ERCOT_WEST_NORTH_DA_BASIS")
        self.assertIsInstance(reading.value, int)
        self.assertEqual(len(reading.source_hash), 64)
        self.assertEqual(len(reading.metric_hash), 32)

    def test_fuel_mix_is_not_in_publication_scope(self):
        path = next(publish.METRICS_DIR.glob("ERCOT_FUELMIX_*.json"))
        with self.assertRaisesRegex(ValueError, "not frozen"):
            publish.load_reading(path)

    def test_dry_run_cli_is_safe_without_key_or_rpc(self):
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(publish.main(["--limit", "3"]), 0)


class TestLedgerIdempotency(unittest.TestCase):
    def setUp(self):
        self.reading = publish.MetricReading(
            path=Path("metric.json"),
            metric_id="ERCOT_HBNORTH_DA_AVG",
            day_key=20260908,
            market_day_start_utc=1,
            market_day_end_utc=2,
            value=3957,
            source_hash="11" * 32,
        )

    def test_matching_confirmed_entry_is_skipped(self):
        ledger = {
            self.reading.ledger_key: {
                "value": self.reading.value,
                "sourceHash": self.reading.source_hash,
                "status": "confirmed",
            }
        }
        plan = publish.plan_from_ledger([self.reading], ledger)
        self.assertEqual(plan.submit, [])
        self.assertEqual(plan.already_published, 1)

    def test_hash_drift_with_same_value_is_skipped(self):
        ledger = {
            self.reading.ledger_key: {
                "value": self.reading.value,
                "sourceHash": "22" * 32,
                "status": "confirmed",
            }
        }
        plan = publish.plan_from_ledger([self.reading], ledger)
        self.assertEqual(plan.submit, [])
        self.assertEqual(plan.hash_drift, 1)

    def test_value_correction_is_submitted(self):
        ledger = {
            self.reading.ledger_key: {
                "value": self.reading.value - 1,
                "sourceHash": self.reading.source_hash,
                "status": "confirmed",
            }
        }
        plan = publish.plan_from_ledger([self.reading], ledger)
        self.assertEqual(plan.submit, [self.reading])

    def test_finalized_value_cannot_be_changed(self):
        ledger = {
            self.reading.ledger_key: {
                "value": self.reading.value - 1,
                "sourceHash": self.reading.source_hash,
                "status": "finalized",
            }
        }
        with self.assertRaises(publish.PublisherError):
            publish.plan_from_ledger([self.reading], ledger)

    def test_zip_handoff_guard_recovers_matching_onchain_reading(self):
        ledger = {}
        plan = publish.Plan(submit=[self.reading])
        current = {
            "value": self.reading.value,
            "sourceHash": self.reading.source_hash,
            "publishedAt": 1_789_000_000,
            "finalized": False,
        }
        with patch.object(publish, "chain_reading", return_value=current), patch.object(
            publish, "save_ledger"
        ):
            result = publish.protect_against_stale_ledger(None, plan, ledger)
        self.assertEqual(result.submit, [])
        self.assertEqual(result.already_published, 1)
        self.assertEqual(ledger[self.reading.ledger_key]["status"], "confirmed")

    def test_zip_handoff_guard_never_checks_past_submission_limit(self):
        second = publish.MetricReading(
            path=Path("second.json"),
            metric_id=self.reading.metric_id,
            day_key=20260909,
            market_day_start_utc=3,
            market_day_end_utc=4,
            value=4000,
            source_hash="22" * 32,
        )
        ledger = {}
        plan = publish.Plan(submit=[self.reading, second])
        with patch.object(publish, "chain_reading", return_value=None) as chain_call, patch.object(
            publish, "save_ledger"
        ):
            result = publish.protect_against_stale_ledger(
                None, plan, ledger, submission_limit=1
            )
        self.assertEqual(result.submit, [self.reading])
        self.assertEqual(chain_call.call_count, 1)


class TestAtomicLedger(unittest.TestCase):
    def test_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ledger.json"
            with patch.object(publish, "LEDGER_PATH", path):
                publish.save_ledger({"x": {"status": "confirmed"}})
                self.assertEqual(json.loads(path.read_text()), {"x": {"status": "confirmed"}})


class TestCliArguments(unittest.TestCase):
    def test_rejects_nonpositive_limit(self):
        args = argparse.Namespace(days=None, limit=0, start=None, end=None, check=False, live=False)
        with self.assertRaises(publish.PublisherError):
            publish.validate_args(args)


class TestRevertClassification(unittest.TestCase):
    """publish-spec.md §2.7: classify reverts from the contract's own ABI."""

    def setUp(self):
        self.abi = json.loads(publish.ABI_PATH.read_text())
        self.selectors = publish.build_error_selectors(self.abi)

    def _selector_for(self, error_name: str) -> str:
        return next(sel for sel, name in self.selectors.items() if name == error_name)

    def _revert(self, error_name: str) -> ContractCustomError:
        return ContractCustomError(
            "execution reverted", data="0x" + self._selector_for(error_name) + "00" * 28
        )

    def test_selectors_are_derived_from_abi_not_hardcoded(self):
        # Computed independently of publish.build_error_selectors, straight from the
        # known error signature — this fails if the classifier's derivation and the
        # ABI ever disagree on what ReadingAlreadyFinalized's selector is.
        expected_selector = Web3.keccak(
            text="ReadingAlreadyFinalized(bytes32,uint32)"
        )[:4].hex()
        self.assertEqual(self.selectors.get(expected_selector), "ReadingAlreadyFinalized")

    def test_reading_already_finalized_is_expected(self):
        result = publish.classify_revert(self._revert("ReadingAlreadyFinalized"), self.selectors)
        self.assertTrue(result.is_expected)
        self.assertEqual(result.error_name, "ReadingAlreadyFinalized")

    def test_unauthorized_reporter_is_unexpected(self):
        result = publish.classify_revert(self._revert("UnauthorizedReporter"), self.selectors)
        self.assertFalse(result.is_expected)
        self.assertEqual(result.error_name, "UnauthorizedReporter")

    def test_unrecognized_selector_is_unexpected(self):
        exc = ContractCustomError("execution reverted", data="0xdeadbeef")
        result = publish.classify_revert(exc, self.selectors)
        self.assertFalse(result.is_expected)
        self.assertIsNone(result.error_name)


class TestSendReadingRevertHandling(unittest.TestCase):
    """Same classifier, same outcome, whether the revert surfaces at gas
    estimation (before broadcast) or in the mined receipt (after broadcast)."""

    def setUp(self):
        abi = json.loads(publish.ABI_PATH.read_text())
        self.selectors = publish.build_error_selectors(abi)
        self.reading = publish.MetricReading(
            path=Path("metric.json"),
            metric_id="ERCOT_HBNORTH_DA_AVG",
            day_key=20260908,
            market_day_start_utc=1,
            market_day_end_utc=2,
            value=3957,
            source_hash="11" * 32,
        )
        self.account = MagicMock()
        self.account.address = "0xReporter"
        self.function = MagicMock()
        self.contract = MagicMock()
        self.contract.functions.submitReading.return_value = self.function
        self.w3 = MagicMock()
        self.ledger: dict = {}
        self.log_path = Path("unused.log")

    def _selector_for(self, error_name: str) -> str:
        return next(sel for sel, name in self.selectors.items() if name == error_name)

    def _revert(self, error_name: str) -> ContractCustomError:
        return ContractCustomError(
            "execution reverted", data="0x" + self._selector_for(error_name) + "00" * 28
        )

    def _configure_successful_broadcast(self, receipt_status: int):
        self.function.estimate_gas.return_value = 100_000
        self.w3.eth.gas_price = 20_000_000
        self.function.build_transaction.return_value = {
            "gas": 120_000,
            "gasPrice": 20_000_000,
        }
        signed = MagicMock()
        signed.raw_transaction = b"\x01\x02"
        self.account.sign_transaction.return_value = signed
        self.w3.eth.send_raw_transaction.return_value = b"\xaa\xbb"
        receipt = MagicMock()
        receipt.status = receipt_status
        receipt.gasUsed = 100_000
        receipt.blockNumber = 42
        self.w3.eth.wait_for_transaction_receipt.return_value = receipt

    def _send(self, nonce: int = 5):
        return publish.send_reading(
            self.w3,
            self.contract,
            self.account,
            self.reading,
            nonce,
            self.ledger,
            self.log_path,
            self.selectors,
        )

    # 1. EXPECTED at estimate_gas: continue, mark finalized.
    @patch.object(publish, "append_log")
    @patch.object(publish, "save_ledger")
    @patch.object(publish, "chain_reading")
    def test_expected_revert_at_estimate_gas_continues_and_marks_finalized(
        self, mock_chain_reading, mock_save_ledger, mock_append_log
    ):
        self.function.estimate_gas.side_effect = self._revert("ReadingAlreadyFinalized")
        mock_chain_reading.return_value = {
            "value": self.reading.value,
            "sourceHash": self.reading.source_hash,
            "publishedAt": 1_789_000_000,
            "finalized": True,
        }
        cost, nonce = self._send(nonce=5)
        self.assertEqual((cost, nonce), (0, 5))
        self.assertEqual(self.ledger[self.reading.ledger_key]["status"], "finalized")
        self.function.build_transaction.assert_not_called()

    # 2. UNEXPECTED at estimate_gas: abort.
    @patch.object(publish, "append_log")
    @patch.object(publish, "save_ledger")
    def test_unexpected_revert_at_estimate_gas_aborts(self, mock_save_ledger, mock_append_log):
        self.function.estimate_gas.side_effect = self._revert("UnauthorizedReporter")
        with self.assertRaises(publish.PublisherError):
            self._send(nonce=5)
        self.function.build_transaction.assert_not_called()
        self.assertNotIn(self.reading.ledger_key, self.ledger)

    # 3a. The same EXPECTED error, surfacing post-receipt instead: same classification.
    @patch.object(publish, "append_log")
    @patch.object(publish, "save_ledger")
    @patch.object(publish, "chain_reading")
    def test_expected_revert_post_receipt_continues_and_marks_finalized(
        self, mock_chain_reading, mock_save_ledger, mock_append_log
    ):
        self._configure_successful_broadcast(receipt_status=0)
        self.function.call.side_effect = self._revert("ReadingAlreadyFinalized")
        mock_chain_reading.return_value = {
            "value": self.reading.value,
            "sourceHash": self.reading.source_hash,
            "publishedAt": 1_789_000_000,
            "finalized": True,
        }
        cost, nonce = self._send(nonce=5)
        self.assertEqual(nonce, 6)
        self.assertEqual(self.ledger[self.reading.ledger_key]["status"], "finalized")

    # 3b. The same UNEXPECTED error, surfacing post-receipt instead: same classification.
    @patch.object(publish, "append_log")
    @patch.object(publish, "save_ledger")
    def test_unexpected_revert_post_receipt_aborts(self, mock_save_ledger, mock_append_log):
        self._configure_successful_broadcast(receipt_status=0)
        self.function.call.side_effect = self._revert("UnauthorizedReporter")
        with self.assertRaises(publish.PublisherError):
            self._send(nonce=5)

    # 4. Unrecognized selector: also aborts, since an unknown failure isn't safe to
    # continue through.
    @patch.object(publish, "append_log")
    @patch.object(publish, "save_ledger")
    def test_unrecognized_revert_at_estimate_gas_aborts(self, mock_save_ledger, mock_append_log):
        self.function.estimate_gas.side_effect = ContractCustomError(
            "execution reverted", data="0xdeadbeef"
        )
        with self.assertRaises(publish.PublisherError):
            self._send(nonce=5)
        self.function.build_transaction.assert_not_called()


if __name__ == "__main__":
    unittest.main()
