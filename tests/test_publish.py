import argparse
import contextlib
import io
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from web3 import Web3
from web3.exceptions import ContractCustomError

import publish


def count_field(label: str, output: str) -> int:
    match = re.search(rf"{re.escape(label)}\s*(\d+)", output)
    assert match, f"label {label!r} not found in output:\n{output}"
    return int(match.group(1))


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


class TestLiveRunSummary(unittest.TestCase):
    """publish-spec.md §2.11: the end-of-run summary must be able to report
    a real UNEXPECTED failure, and must print on every exit path of a live
    run, including one that aborts partway through the submission loop."""

    def setUp(self):
        self.readings = [
            publish.MetricReading(
                path=Path(f"metric{i}.json"),
                metric_id="ERCOT_HBNORTH_DA_AVG",
                day_key=20260908 + i,
                market_day_start_utc=1,
                market_day_end_utc=2,
                value=3957 + i,
                source_hash="11" * 32,
            )
            for i in range(3)
        ]
        self.account = MagicMock()
        self.account.address = "0xSigner"
        self.w3 = MagicMock()
        self.w3.eth.get_transaction_count.return_value = 10
        self.w3.eth.gas_price = 20_000_000
        self.contract = MagicMock()
        self.contract.abi = []  # real build_error_selectors() needs an iterable ABI

    @staticmethod
    def _count(label: str, output: str) -> int:
        match = re.search(rf"{re.escape(label)}\s*(\d+)", output)
        assert match, f"label {label!r} not found in output:\n{output}"
        return int(match.group(1))

    def _run_live(self, send_reading_side_effect, invalid=None):
        patches = [
            patch.object(publish, "load_deployment", return_value=(1952, "0xOracle")),
            patch.object(publish, "load_ledger", return_value={}),
            patch.object(
                publish, "collect_readings", return_value=(self.readings, invalid or [])
            ),
            patch.object(publish, "load_reporter_account", return_value=self.account),
            patch.object(publish, "make_web3", return_value=self.w3),
            patch.object(publish, "load_contract", return_value=self.contract),
            patch.object(publish, "preflight", return_value=(1952, 10**18)),
            patch.object(publish, "recover_submitted_entries", return_value=None),
            patch.object(
                publish,
                "protect_against_stale_ledger",
                side_effect=lambda contract, plan, ledger, submission_limit=None: plan,
            ),
            patch.object(publish, "send_reading", side_effect=send_reading_side_effect),
            patch("builtins.input", return_value="yes"),
        ]
        with contextlib.ExitStack() as stack:
            for one_patch in patches:
                stack.enter_context(one_patch)
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                exit_code = publish.main(["--live"])
        return exit_code, buffer.getvalue()

    def test_aborted_run_still_prints_summary_with_accurate_partial_counts(self):
        exit_code, output = self._run_live(
            [(1_000, 11), publish.PublisherError("boom: unauthorized reporter")]
        )
        self.assertIn("GRIDFLEX publish summary", output)
        self.assertEqual(self._count("Submitted:", output), 1)
        self.assertEqual(self._count("Failed (UNEXPECTED):", output), 1)

    def test_failed_counter_reflects_a_real_unexpected_failure(self):
        _, output_with_failure = self._run_live(
            [publish.PublisherError("boom: unauthorized reporter")]
        )
        _, output_clean = self._run_live([(1_000, 11), (1_000, 12), (1_000, 13)])
        self.assertEqual(self._count("Failed (UNEXPECTED):", output_with_failure), 1)
        self.assertEqual(self._count("Failed (UNEXPECTED):", output_clean), 0)

    def test_exit_code_nonzero_on_unexpected_failure(self):
        exit_code, _ = self._run_live([publish.PublisherError("boom: unauthorized reporter")])
        self.assertEqual(exit_code, 1)

    def test_exit_code_nonzero_when_a_file_was_skipped_as_invalid(self):
        exit_code, _ = self._run_live(
            [(1_000, 11), (1_000, 12), (1_000, 13)],
            invalid=["ERCOT_HBNORTH_DA_AVG__20260910.json: missing key 'value'"],
        )
        self.assertEqual(exit_code, 1)

    def test_non_publisher_error_during_send_still_aborts_and_prints_summary(self):
        """publish-spec.md §2.8, now fixed: a transport failure (not a
        PublisherError) from send_reading must not escape past the summary -
        it's routed through the same UNEXPECTED-failure path as any other
        abort, with accurate partial counts."""
        exit_code, output = self._run_live(
            [(1_000, 11), ConnectionError("RPC connection dropped")]
        )
        self.assertIn("GRIDFLEX publish summary", output)
        self.assertEqual(self._count("Submitted:", output), 1)
        self.assertEqual(self._count("Failed (UNEXPECTED):", output), 1)
        self.assertEqual(exit_code, 1)

    def test_clean_run_prints_zeros_and_exits_zero(self):
        exit_code, output = self._run_live([(1_000, 11), (1_000, 12), (1_000, 13)])
        self.assertEqual(exit_code, 0)
        self.assertEqual(self._count("Submitted:", output), 3)
        self.assertEqual(self._count("Failed (UNEXPECTED):", output), 0)
        self.assertEqual(self._count("Already published (skipped):", output), 0)
        self.assertEqual(self._count("Already finalized (skipped):", output), 0)
        self.assertEqual(self._count("Invalid files (skipped):", output), 0)


class TestSendReadingNonceRetry(unittest.TestCase):
    """publish-spec.md §2.8: a "nonce too low" send error must re-sync from
    chain and retry once — a transient hiccup must not abort an hour-long
    run."""

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
        self.account = MagicMock()
        self.account.address = "0xReporter"
        signed = MagicMock()
        signed.raw_transaction = b"\x01\x02"
        self.account.sign_transaction.return_value = signed
        self.function = MagicMock()
        self.function.estimate_gas.return_value = 100_000
        self.function.build_transaction.return_value = {"gas": 120_000, "gasPrice": 20_000_000}
        self.contract = MagicMock()
        self.contract.functions.submitReading.return_value = self.function
        self.w3 = MagicMock()
        self.w3.eth.gas_price = 20_000_000
        receipt = MagicMock()
        receipt.status = 1
        receipt.gasUsed = 100_000
        receipt.blockNumber = 42
        self.w3.eth.wait_for_transaction_receipt.return_value = receipt
        self.ledger: dict = {}

    @patch.object(publish, "append_log")
    @patch.object(publish, "save_ledger")
    def test_nonce_too_low_resyncs_and_retries_once(self, mock_save_ledger, mock_append_log):
        self.w3.eth.get_transaction_count.return_value = 8  # chain has moved on
        self.w3.eth.send_raw_transaction.side_effect = [
            ValueError("nonce too low: next nonce 8, tx nonce 5"),
            b"\xaa\xbb",
        ]
        cost, next_nonce = publish.send_reading(
            self.w3, self.contract, self.account, self.reading, 5, self.ledger,
            Path("unused.log"), {},
        )
        self.assertEqual(self.w3.eth.send_raw_transaction.call_count, 2)
        self.assertEqual(next_nonce, 9)  # resynced nonce (8) + 1, not the stale 5 + 1
        self.assertEqual(cost, 100_000 * 20_000_000)
        self.assertEqual(self.ledger[self.reading.ledger_key]["nonce"], 8)

    @patch.object(publish, "append_log")
    @patch.object(publish, "save_ledger")
    def test_nonce_too_low_aborts_cleanly_if_the_retry_also_fails(
        self, mock_save_ledger, mock_append_log
    ):
        self.w3.eth.get_transaction_count.return_value = 8
        self.w3.eth.send_raw_transaction.side_effect = [
            ValueError("nonce too low: next nonce 8, tx nonce 5"),
            ValueError("nonce too low: next nonce 9, tx nonce 8"),
        ]
        with self.assertRaises(publish.PublisherError):
            publish.send_reading(
                self.w3, self.contract, self.account, self.reading, 5, self.ledger,
                Path("unused.log"), {},
            )
        self.assertEqual(self.w3.eth.send_raw_transaction.call_count, 2)


class TestRecoverSubmittedEntriesGuard(unittest.TestCase):
    """A malformed ledger entry (e.g. a null nonce from a hand-edited
    handoff) must fail with a clean PublisherError, not a raw traceback —
    matching the per-entry guard reconcile() already has."""

    @patch.object(publish, "save_ledger")
    @patch.object(publish, "chain_reading", return_value=None)
    def test_malformed_entry_raises_clean_publisher_error(
        self, mock_chain_reading, mock_save_ledger
    ):
        ledger = {
            "ERCOT_HBNORTH_DA_AVG:20260908": {
                "value": 3957,
                "sourceHash": "11" * 32,
                "status": "submitted",
                "nonce": None,  # hand-edited handoff corrupted this field
            }
        }
        w3 = MagicMock()
        w3.eth.get_transaction_count.return_value = 10
        contract = MagicMock()
        account = MagicMock()
        account.address = "0xReporter"
        with self.assertRaises(publish.PublisherError) as ctx:
            publish.recover_submitted_entries(w3, contract, account, ledger)
        self.assertIn("ERCOT_HBNORTH_DA_AVG:20260908", str(ctx.exception))
        self.assertIn("malformed ledger entry", str(ctx.exception))

    @patch.object(publish, "save_ledger")
    def test_stuck_entry_never_broadcast_is_deleted_and_logged_loudly(self, mock_save_ledger):
        # pending_nonce <= entry's nonce: the tx never actually left the
        # process, so it's safe to drop — but per the spec's named recovery
        # behaviour, this must be logged loudly, not silent.
        ledger = {
            "ERCOT_HBNORTH_DA_AVG:20260908": {
                "value": 3957,
                "sourceHash": "11" * 32,
                "status": "submitted",
                "nonce": 5,
            }
        }
        w3 = MagicMock()
        w3.eth.get_transaction_count.return_value = 5
        contract = MagicMock()
        account = MagicMock()
        account.address = "0xReporter"
        with patch.object(publish, "chain_reading", return_value=None):
            buffer = io.StringIO()
            with contextlib.redirect_stderr(buffer):
                publish.recover_submitted_entries(w3, contract, account, ledger)
        self.assertNotIn("ERCOT_HBNORTH_DA_AVG:20260908", ledger)
        self.assertIn("RESOLVED", buffer.getvalue())


class TestDryRunReconcilesPendingEntries(unittest.TestCase):
    """A dry run must resolve a leftover `submitted` ledger row (from a
    crashed prior run) before reporting its plan — the same way `--live`
    does — but only when such a row actually exists, so a clean ledger
    still needs no reporter key or RPC connection at all."""

    def test_pending_submitted_entry_is_resolved_before_the_plan_is_built(self):
        reading = publish.MetricReading(
            path=Path("metric.json"),
            metric_id="ERCOT_HBNORTH_DA_AVG",
            day_key=20260908,
            market_day_start_utc=1,
            market_day_end_utc=2,
            value=3957,
            source_hash="11" * 32,
        )
        ledger = {
            reading.ledger_key: {
                "value": reading.value,
                "sourceHash": reading.source_hash,
                "status": "submitted",
                "nonce": 5,
            }
        }

        def fake_recover(w3, contract, account, ledger_arg):
            ledger_arg[reading.ledger_key]["status"] = "confirmed"

        account = MagicMock()
        account.address = "0xReporter"

        with patch.object(
            publish, "load_deployment", return_value=(1952, "0xOracle")
        ), patch.object(publish, "load_ledger", return_value=ledger), patch.object(
            publish, "collect_readings", return_value=([reading], [])
        ), patch.object(
            publish, "make_web3", return_value=MagicMock()
        ) as mock_make_web3, patch.object(
            publish, "load_contract", return_value=MagicMock()
        ), patch.object(
            publish, "load_reporter_account", return_value=account
        ) as mock_load_account, patch.object(
            publish, "recover_submitted_entries", side_effect=fake_recover
        ) as mock_recover:
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                exit_code = publish.main([])

        mock_recover.assert_called_once()
        mock_load_account.assert_called_once()
        mock_make_web3.assert_called_once()
        self.assertEqual(exit_code, 0)
        output = buffer.getvalue()
        self.assertEqual(count_field("Readings to submit:", output), 0)
        self.assertEqual(count_field("Already published (skipped):", output), 1)

    def test_clean_ledger_still_needs_no_key_or_rpc(self):
        # Regression guard for the gating itself: with no "submitted" rows,
        # recover_submitted_entries must never be reached, so a dry run with
        # no reporter key configured still succeeds exactly as before.
        with patch.dict("os.environ", {}, clear=True):
            with patch.object(
                publish, "recover_submitted_entries"
            ) as mock_recover, contextlib.redirect_stdout(io.StringIO()):
                exit_code = publish.main(["--limit", "3"])
        mock_recover.assert_not_called()
        self.assertEqual(exit_code, 0)


class TestStaleLedgerGuardPacing(unittest.TestCase):
    """publish-spec.md §2.9: every getReading call against the shared public
    RPC endpoint needs the same 0.5s courtesy pacing reconcile() already
    has — up to ~1,445 back-to-back calls otherwise."""

    def test_sleeps_once_per_chain_reading_call(self):
        first = publish.MetricReading(
            path=Path("metric.json"),
            metric_id="ERCOT_HBNORTH_DA_AVG",
            day_key=20260908,
            market_day_start_utc=1,
            market_day_end_utc=2,
            value=3957,
            source_hash="11" * 32,
        )
        second = publish.MetricReading(
            path=Path("second.json"),
            metric_id=first.metric_id,
            day_key=20260909,
            market_day_start_utc=3,
            market_day_end_utc=4,
            value=4000,
            source_hash="22" * 32,
        )
        ledger: dict = {}
        plan = publish.Plan(submit=[first, second])
        with patch.object(
            publish, "chain_reading", return_value=None
        ) as mock_chain_reading, patch.object(publish, "save_ledger"), patch.object(
            publish.time, "sleep"
        ) as mock_sleep:
            publish.protect_against_stale_ledger(None, plan, ledger)
        self.assertEqual(mock_chain_reading.call_count, 2)
        self.assertEqual(mock_sleep.call_count, 2)
        mock_sleep.assert_called_with(0.5)


if __name__ == "__main__":
    unittest.main()
