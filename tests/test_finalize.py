import contextlib
import io
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from web3.exceptions import ContractCustomError

import finalize
import publish


def count_field(label: str, output: str) -> int:
    match = re.search(rf"{re.escape(label)}\s*(\d+)", output)
    assert match, f"label {label!r} not found in output:\n{output}"
    return int(match.group(1))


def final_summary(output: str) -> str:
    """print_plan (evaluation-time) and print_summary (post-send) share a
    couple of label strings; isolate the end-of-run block for assertions
    that must reflect what happened during the live send, not the plan."""
    marker = "GRIDFLEX finalize summary"
    assert marker in output, f"{marker!r} not found in output:\n{output}"
    return output.rsplit(marker, 1)[-1]


def make_reading(
    metric_id: str = "ERCOT_HBNORTH_DA_AVG",
    day_key: int = 20260908,
    value: int = 3957,
    source_hash: str | None = None,
) -> publish.MetricReading:
    return publish.MetricReading(
        path=Path(f"{metric_id}__{day_key}.json"),
        metric_id=metric_id,
        day_key=day_key,
        market_day_start_utc=1,
        market_day_end_utc=2,
        value=value,
        source_hash=source_hash or ("11" * 32),
    )


def chain_row(value: int, source_hash: str, published_at: int, finalized: bool) -> dict:
    return {
        "value": value,
        "sourceHash": source_hash,
        "publishedAt": published_at,
        "finalized": finalized,
    }


DEMO_TABLE_OK = """# GRIDFLEX demo markets

## Summary table

| # | Metric | Question threshold | dayKey | Date | Base rate used | Basis for rate |
|---|---|---|---|---|---|---|
| 1 | `ERCOT_HBNORTH_DA_AVG` | > $30 | `20260908` | 2026-09-08 (past) | 41.0% | annual |
| 2 | `ERCOT_HBNORTH_DA_AVG` | > $30 | `20260924` | 2026-09-24 | 41.0% / 50.0% | annual + window agree |
| 3 | `ERCOT_HBNORTH_DA_AVG` | > $30 | `20261005` | 2026-10-05 | 41.0% / 50.0% | annual + window agree |
| 4 | `ERCOT_WEST_NORTH_DA_BASIS` | > $0 | `20260812` | 2026-08-12 (past) | 55.4% | annual |
| 5 | `ERCOT_WEST_NORTH_DA_BASIS` | > $4 | `20260924` | 2026-09-24 | 60.0% | window |
| 6 | `ERCOT_WEST_NORTH_DA_BASIS` | > $4 | `20261005` | 2026-10-05 | 60.0% | window |

### Note

Some prose after the table that must not be swept into it.
"""

DEMO_ROWS = [
    ("ERCOT_HBNORTH_DA_AVG", 20260908),
    ("ERCOT_HBNORTH_DA_AVG", 20260924),
    ("ERCOT_HBNORTH_DA_AVG", 20261005),
    ("ERCOT_WEST_NORTH_DA_BASIS", 20260812),
    ("ERCOT_WEST_NORTH_DA_BASIS", 20260924),
    ("ERCOT_WEST_NORTH_DA_BASIS", 20261005),
]


def write_demo_table(directory: Path, content: str) -> Path:
    path = directory / "demo-markets.md"
    path.write_text(content, encoding="utf-8")
    return path


class BaseFinalizeTest(unittest.TestCase):
    """Common plumbing: a fake deployment/contract and no real RPC or sleeps."""

    def setUp(self):
        self.w3 = MagicMock()
        self.w3.eth.chain_id = 1952
        self.w3.eth.get_code.return_value = b"\x60\x80"  # non-empty bytecode
        self.contract = MagicMock()
        self.contract.address = "0xOracle"
        self.contract.abi = []
        self.contract.functions.disputeWindow.return_value.call.return_value = 3600
        self._patches = [
            patch.object(finalize, "load_deployment", return_value=(1952, "0xOracle")),
            patch.object(finalize, "make_web3", return_value=self.w3),
            patch.object(finalize, "load_contract", return_value=self.contract),
            patch.object(finalize.time, "sleep", return_value=None),
        ]
        for one in self._patches:
            one.start()
            self.addCleanup(one.stop)


class TestEvaluateReading(unittest.TestCase):
    """finalize-spec.md §1-§3: discovery/eligibility/value-match, all from a
    single fresh on-chain read."""

    def setUp(self):
        self.reading = make_reading(value=100, source_hash="11" * 32)
        self.contract = MagicMock()
        self.dispute_window = 3600
        self.now = 2_000_000_000

    def _evaluate(self, current):
        with patch.object(finalize, "chain_reading", return_value=current):
            return finalize.evaluate_reading(self.contract, self.dispute_window, self.reading, self.now)

    def test_not_published(self):
        self.assertEqual(self._evaluate(None).status, finalize.STATUS_NOT_PUBLISHED)

    def test_already_finalized(self):
        current = chain_row(100, "11" * 32, self.now - 10_000, True)
        self.assertEqual(self._evaluate(current).status, finalize.STATUS_ALREADY_FINALIZED)

    def test_waiting_inside_dispute_window_reports_remaining_time(self):
        published_at = self.now - 1000  # window is 3600s, only 1000s have elapsed
        current = chain_row(100, "11" * 32, published_at, False)
        evaluation = self._evaluate(current)
        self.assertEqual(evaluation.status, finalize.STATUS_WAITING)
        self.assertEqual(evaluation.finalizable_at, published_at + self.dispute_window)
        self.assertGreater(evaluation.finalizable_at, self.now)

    def test_value_mismatch_blocks_even_past_the_dispute_window(self):
        published_at = self.now - 4000  # past the window
        current = chain_row(999, "11" * 32, published_at, False)  # value differs from local file
        self.assertEqual(self._evaluate(current).status, finalize.STATUS_VALUE_MISMATCH)

    def test_source_hash_only_drift_is_not_a_mismatch(self):
        published_at = self.now - 4000
        current = chain_row(100, "22" * 32, published_at, False)  # only hash differs
        self.assertEqual(self._evaluate(current).status, finalize.STATUS_ELIGIBLE)

    def test_eligible_when_value_matches_and_window_has_passed(self):
        published_at = self.now - 4000
        current = chain_row(100, "11" * 32, published_at, False)
        self.assertEqual(self._evaluate(current).status, finalize.STATUS_ELIGIBLE)


class TestDemoMarketsTableParsing(unittest.TestCase):
    def test_parses_all_six_rows_from_the_real_shaped_table(self):
        with tempfile.TemporaryDirectory() as directory:
            path = write_demo_table(Path(directory), DEMO_TABLE_OK)
            rows = finalize.parse_demo_markets_summary_table(path)
        self.assertEqual(rows, DEMO_ROWS)

    def test_missing_heading_fails_loudly(self):
        with tempfile.TemporaryDirectory() as directory:
            path = write_demo_table(Path(directory), "# No summary table here\n\nJust prose.\n")
            with self.assertRaises(publish.PublisherError):
                finalize.parse_demo_markets_summary_table(path)

    def test_wrong_header_column_count_fails_loudly(self):
        broken = DEMO_TABLE_OK.replace(
            "| # | Metric | Question threshold | dayKey | Date | Base rate used | Basis for rate |",
            "| # | Metric | dayKey | Date |",
        )
        with tempfile.TemporaryDirectory() as directory:
            path = write_demo_table(Path(directory), broken)
            with self.assertRaisesRegex(publish.PublisherError, "columns"):
                finalize.parse_demo_markets_summary_table(path)

    def test_wrong_row_column_count_fails_loudly(self):
        broken = DEMO_TABLE_OK.replace(
            "| 3 | `ERCOT_HBNORTH_DA_AVG` | > $30 | `20261005` | 2026-10-05 | 41.0% / 50.0% | annual + window agree |",
            "| 3 | `ERCOT_HBNORTH_DA_AVG` | `20261005` |",
        )
        with tempfile.TemporaryDirectory() as directory:
            path = write_demo_table(Path(directory), broken)
            with self.assertRaisesRegex(publish.PublisherError, "columns"):
                finalize.parse_demo_markets_summary_table(path)

    def test_unrecognized_metric_id_fails_loudly(self):
        broken = DEMO_TABLE_OK.replace("`ERCOT_HBNORTH_DA_AVG`", "`ERCOT_TOTALLY_NEW_METRIC`", 1)
        with tempfile.TemporaryDirectory() as directory:
            path = write_demo_table(Path(directory), broken)
            with self.assertRaises(publish.PublisherError):
                finalize.parse_demo_markets_summary_table(path)

    def test_no_data_rows_fails_loudly(self):
        heading_only = (
            "## Summary table\n\n"
            "| # | Metric | Question threshold | dayKey | Date | Base rate used | Basis for rate |\n"
            "|---|---|---|---|---|---|---|\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            path = write_demo_table(Path(directory), heading_only)
            with self.assertRaises(publish.PublisherError):
                finalize.parse_demo_markets_summary_table(path)


class TestVerify(BaseFinalizeTest):
    def _chain_reading_for(self, states: dict[tuple[str, int], dict | None]):
        def fake(contract, reading):
            return states.get((reading.metric_id, reading.day_key))
        return fake

    def test_verify_needs_no_key_keystore_or_wallet(self):
        states = {row: chain_row(1, "11" * 32, 1_000_000_000, True) for row in DEMO_ROWS}
        with tempfile.TemporaryDirectory() as directory:
            table_path = write_demo_table(Path(directory), DEMO_TABLE_OK)
            with patch.dict("os.environ", {}, clear=True), \
                    patch.object(finalize, "DEMO_MARKETS_PATH", table_path), \
                    patch.object(finalize, "chain_reading", side_effect=self._chain_reading_for(states)), \
                    patch.object(finalize, "load_finalizer_account") as mock_load_account, \
                    contextlib.redirect_stdout(io.StringIO()):
                exit_code = finalize.main(["--verify"])
        mock_load_account.assert_not_called()
        self.assertEqual(exit_code, 0)

    def test_reports_finalized_waiting_and_not_published(self):
        now = 1_800_003_700
        states = {
            ("ERCOT_HBNORTH_DA_AVG", 20260908): chain_row(3957, "aa" * 32, now - 4000, True),
            ("ERCOT_HBNORTH_DA_AVG", 20260924): chain_row(3100, "bb" * 32, now - 1000, False),
            ("ERCOT_HBNORTH_DA_AVG", 20261005): None,
            ("ERCOT_WEST_NORTH_DA_BASIS", 20260812): chain_row(-1032, "cc" * 32, now - 4000, True),
            ("ERCOT_WEST_NORTH_DA_BASIS", 20260924): chain_row(400, "dd" * 32, now - 4000, True),
            ("ERCOT_WEST_NORTH_DA_BASIS", 20261005): chain_row(374, "ee" * 32, now - 4000, True),
        }
        with tempfile.TemporaryDirectory() as directory:
            table_path = write_demo_table(Path(directory), DEMO_TABLE_OK)
            with patch.object(finalize, "DEMO_MARKETS_PATH", table_path), \
                    patch.object(finalize, "chain_reading", side_effect=self._chain_reading_for(states)), \
                    patch.object(finalize.time, "time", return_value=now):
                buffer = io.StringIO()
                with contextlib.redirect_stdout(buffer):
                    exit_code = finalize.main(["--verify"])
        output = buffer.getvalue()
        self.assertEqual(exit_code, 1)
        self.assertIn("ERCOT_HBNORTH_DA_AVG", output)
        self.assertIn("dayKey 20260908", output)
        self.assertIn("PUBLISHED, FINALIZED", output)
        self.assertIn("dayKey 20260924", output)
        self.assertIn("not finalized", output)
        self.assertIn("remaining", output)
        self.assertIn("eligible at", output)
        self.assertIn("dayKey 20261005", output)
        self.assertIn("NOT PUBLISHED", output)

    def test_exits_zero_only_when_every_row_is_published_and_finalized(self):
        now = 1_800_000_000
        all_final = {row: chain_row(1, "11" * 32, now - 4000, True) for row in DEMO_ROWS}
        with tempfile.TemporaryDirectory() as directory:
            table_path = write_demo_table(Path(directory), DEMO_TABLE_OK)
            with patch.object(finalize, "DEMO_MARKETS_PATH", table_path), \
                    patch.object(finalize, "chain_reading", side_effect=self._chain_reading_for(all_final)), \
                    patch.object(finalize.time, "time", return_value=now), \
                    contextlib.redirect_stdout(io.StringIO()):
                exit_code = finalize.main(["--verify"])
        self.assertEqual(exit_code, 0)

    def test_ad_hoc_metric_and_day_key_checks_only_that_pair(self):
        with patch.object(finalize, "parse_demo_markets_summary_table") as mock_parse, \
                patch.object(
                    finalize,
                    "chain_reading",
                    return_value=chain_row(500, "11" * 32, 1_000_000_000, True),
                ) as mock_chain_reading, \
                contextlib.redirect_stdout(io.StringIO()):
            exit_code = finalize.main(
                ["--verify", "--metric", "ERCOT_HBNORTH_DA_AVG", "--day-key", "20260910"]
            )
        mock_parse.assert_not_called()
        self.assertEqual(mock_chain_reading.call_count, 1)
        _, probe = mock_chain_reading.call_args[0]
        self.assertEqual((probe.metric_id, probe.day_key), ("ERCOT_HBNORTH_DA_AVG", 20260910))
        self.assertEqual(exit_code, 0)

    def test_malformed_summary_table_fails_loudly_and_checks_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            table_path = write_demo_table(Path(directory), "# no summary table section\n")
            with patch.object(finalize, "DEMO_MARKETS_PATH", table_path), \
                    patch.object(finalize, "chain_reading") as mock_chain_reading:
                buffer = io.StringIO()
                with contextlib.redirect_stderr(buffer):
                    exit_code = finalize.main(["--verify"])
        mock_chain_reading.assert_not_called()
        self.assertEqual(exit_code, 1)
        self.assertIn("ERROR", buffer.getvalue())

    def test_verify_refuses_wrong_chain(self):
        self.w3.eth.chain_id = 196
        with tempfile.TemporaryDirectory() as directory:
            table_path = write_demo_table(Path(directory), DEMO_TABLE_OK)
            with patch.object(finalize, "DEMO_MARKETS_PATH", table_path), \
                    patch.object(finalize, "chain_reading") as mock_chain_reading:
                buffer = io.StringIO()
                with contextlib.redirect_stderr(buffer):
                    exit_code = finalize.main(["--verify"])
        mock_chain_reading.assert_not_called()
        self.assertEqual(exit_code, 1)
        self.assertIn("Wrong chain", buffer.getvalue())


class TestConfirmationBanner(unittest.TestCase):
    def _evaluation(self, day_key):
        reading = make_reading(day_key=day_key)
        return finalize.Evaluation(
            reading, finalize.STATUS_ELIGIBLE, chain_row(reading.value, reading.source_hash, 1, False), 1
        )

    def test_lists_readings_individually_at_or_under_cap(self):
        eligible = [self._evaluation(20260908 + i) for i in range(25)]
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            finalize.confirmation_banner(1952, "0xOracle", "0xSigner", 10**18, eligible, 20_000_000)
        output = buffer.getvalue()
        for evaluation in eligible:
            self.assertIn(str(evaluation.reading.day_key), output)
        self.assertNotIn("Sample (first", output)

    def test_falls_back_to_per_metric_counts_above_cap(self):
        eligible = [self._evaluation(20260908 + i) for i in range(30)]
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            finalize.confirmation_banner(1952, "0xOracle", "0xSigner", 10**18, eligible, 20_000_000)
        output = buffer.getvalue()
        self.assertIn("ERCOT_HBNORTH_DA_AVG: 30", output)
        self.assertIn("Sample (first 10)", output)
        # A day well past the sample window must not appear individually.
        self.assertNotIn(str(eligible[-1].reading.day_key), output)


class TestAttemptFinalizeRevertHandling(unittest.TestCase):
    """finalize-spec.md §5: per-reading isolation. None of these ever raise;
    the caller decides whether to keep going, and always does."""

    def setUp(self):
        self.abi = json.loads(publish.ABI_PATH.read_text())
        self.selectors = publish.build_error_selectors(self.abi)
        self.reading = make_reading()
        self.account = MagicMock()
        self.account.address = "0xFinalizer"
        self.function = MagicMock()
        self.contract = MagicMock()
        self.contract.functions.finalize.return_value = self.function
        self.w3 = MagicMock()
        self.log_path = Path("unused.log")

    def _selector_for(self, name: str) -> str:
        return next(sel for sel, n in self.selectors.items() if n == name)

    def _revert(self, name: str) -> ContractCustomError:
        return ContractCustomError("execution reverted", data="0x" + self._selector_for(name) + "00" * 28)

    def _call(self, nonce=5):
        return finalize.attempt_finalize(
            self.w3, self.contract, self.account, self.reading, nonce, self.log_path, self.selectors, 20_000_000
        )

    @patch.object(finalize, "append_log")
    def test_already_finalized_at_estimate_gas_is_expected_not_failed(self, _mock_log):
        self.function.estimate_gas.side_effect = self._revert("ReadingAlreadyFinalized")
        outcome, detail, cost, nonce = self._call(nonce=5)
        self.assertEqual(outcome, "ALREADY_FINALIZED")
        self.assertEqual((cost, nonce), (0, 5))
        self.function.build_transaction.assert_not_called()

    @patch.object(finalize, "append_log")
    def test_reading_not_found_is_failed_but_does_not_raise(self, _mock_log):
        self.function.estimate_gas.side_effect = self._revert("ReadingNotFound")
        outcome, detail, cost, nonce = self._call(nonce=5)
        self.assertEqual(outcome, "FAILED")
        self.assertIn("ReadingNotFound", detail)

    @patch.object(finalize, "append_log")
    def test_dispute_window_open_is_failed_but_does_not_raise(self, _mock_log):
        self.function.estimate_gas.side_effect = self._revert("DisputeWindowOpen")
        outcome, detail, cost, nonce = self._call(nonce=5)
        self.assertEqual(outcome, "FAILED")
        self.assertIn("DisputeWindowOpen", detail)

    @patch.object(finalize, "append_log")
    def test_unrecognized_selector_is_failed_but_does_not_raise(self, _mock_log):
        self.function.estimate_gas.side_effect = ContractCustomError(
            "execution reverted", data="0xdeadbeef"
        )
        outcome, detail, cost, nonce = self._call(nonce=5)
        self.assertEqual(outcome, "FAILED")

    @patch.object(finalize, "append_log")
    def test_transport_failure_during_broadcast_is_failed_not_raised(self, _mock_log):
        # publish-spec.md §2.8's known-unfixed gap (a non-ValueError transport
        # failure escaping the classification path) must not be reproduced here.
        self.function.estimate_gas.return_value = 100_000
        self.function.build_transaction.return_value = {"gas": 120_000, "gasPrice": 20_000_000}
        signed = MagicMock()
        signed.raw_transaction = b"\x01\x02"
        self.account.sign_transaction.return_value = signed
        self.w3.eth.send_raw_transaction.side_effect = ConnectionError("RPC connection dropped")
        outcome, detail, cost, nonce = self._call(nonce=5)
        self.assertEqual(outcome, "FAILED")
        self.assertIn("ConnectionError", detail)

    @patch.object(finalize, "append_log")
    def test_successful_finalize_returns_finalized_and_advances_nonce(self, _mock_log):
        self.function.estimate_gas.return_value = 100_000
        self.function.build_transaction.return_value = {"gas": 120_000, "gasPrice": 20_000_000}
        signed = MagicMock()
        signed.raw_transaction = b"\x01\x02"
        self.account.sign_transaction.return_value = signed
        self.w3.eth.send_raw_transaction.return_value = b"\xaa\xbb"
        receipt = MagicMock()
        receipt.status = 1
        receipt.gasUsed = 90_000
        receipt.blockNumber = 42
        self.w3.eth.wait_for_transaction_receipt.return_value = receipt
        outcome, detail, cost, nonce = self._call(nonce=5)
        self.assertEqual(outcome, "FINALIZED")
        self.assertEqual(nonce, 6)
        self.assertEqual(cost, 90_000 * 20_000_000)

    @patch.object(finalize, "append_log")
    def test_already_finalized_post_receipt_is_expected_not_failed(self, _mock_log):
        self.function.estimate_gas.return_value = 100_000
        self.function.build_transaction.return_value = {"gas": 120_000, "gasPrice": 20_000_000}
        signed = MagicMock()
        signed.raw_transaction = b"\x01\x02"
        self.account.sign_transaction.return_value = signed
        self.w3.eth.send_raw_transaction.return_value = b"\xaa\xbb"
        receipt = MagicMock()
        receipt.status = 0
        receipt.blockNumber = 42
        self.w3.eth.wait_for_transaction_receipt.return_value = receipt
        self.function.call.side_effect = self._revert("ReadingAlreadyFinalized")
        outcome, detail, cost, nonce = self._call(nonce=5)
        self.assertEqual(outcome, "ALREADY_FINALIZED")
        self.assertEqual(nonce, 6)


class TestLiveRunPerReadingIsolation(BaseFinalizeTest):
    """A revert on one reading must not stop the run from finalizing the
    others; only a preflight failure (wrong chain, no contract code) aborts
    everything."""

    def setUp(self):
        super().setUp()
        self.readings = [make_reading(day_key=20260908 + i, value=100 + i) for i in range(3)]
        self.w3.eth.get_transaction_count.return_value = 10
        self.w3.eth.gas_price = 20_000_000
        self.w3.eth.get_balance.return_value = 10**18

    def _states_all_eligible(self, now):
        return {
            (r.metric_id, r.day_key): chain_row(r.value, r.source_hash, now - 4000, False)
            for r in self.readings
        }

    def _run_live(self, attempt_side_effect):
        now = 1_800_000_000
        with patch.object(finalize, "collect_readings", return_value=(self.readings, [])), \
                patch.object(
                    finalize, "chain_reading",
                    side_effect=lambda c, r: self._states_all_eligible(now).get((r.metric_id, r.day_key)),
                ), \
                patch.object(finalize.time, "time", return_value=now), \
                patch.object(finalize, "ledger_entry_from_chain", return_value={"status": "confirmed"}), \
                patch.object(finalize, "load_ledger", return_value={}), \
                patch.object(finalize, "save_ledger"), \
                patch.object(finalize, "build_error_selectors", return_value={}), \
                patch.object(finalize, "load_finalizer_account", return_value=MagicMock(address="0xFinalizer")), \
                patch.object(finalize, "attempt_finalize", side_effect=attempt_side_effect), \
                patch("builtins.input", return_value="yes"):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                exit_code = finalize.main(["--live"])
        return exit_code, buffer.getvalue()

    def test_one_unexpected_failure_does_not_stop_the_others(self):
        exit_code, output = self._run_live(
            [
                ("FINALIZED", "", 1000, 11),
                ("FAILED", "ReadingNotFound", 0, 11),
                ("FINALIZED", "", 1000, 12),
            ]
        )
        self.assertEqual(count_field("Finalized:", output), 2)
        self.assertEqual(count_field("Failed (skipped, this reading):", output), 1)
        self.assertEqual(exit_code, 1)

    def test_already_finalized_race_during_send_does_not_count_as_failed(self):
        exit_code, output = self._run_live(
            [
                ("FINALIZED", "", 1000, 11),
                ("ALREADY_FINALIZED", "raced by someone else", 0, 12),
                ("FINALIZED", "", 1000, 13),
            ]
        )
        summary = final_summary(output)
        self.assertEqual(count_field("Finalized:", summary), 2)
        self.assertEqual(count_field("Already finalized (skipped):", summary), 1)
        self.assertEqual(count_field("Failed (skipped, this reading):", summary), 0)
        self.assertEqual(exit_code, 0)

    def test_preflight_failure_aborts_before_any_reading_is_attempted(self):
        self.w3.eth.chain_id = 196
        with patch.object(finalize, "collect_readings") as mock_collect, \
                patch.object(finalize, "attempt_finalize") as mock_attempt:
            buffer = io.StringIO()
            with contextlib.redirect_stderr(buffer):
                with contextlib.redirect_stdout(io.StringIO()):
                    exit_code = finalize.main(["--live"])
        mock_collect.assert_not_called()
        mock_attempt.assert_not_called()
        self.assertEqual(exit_code, 1)
        self.assertIn("Wrong chain", buffer.getvalue())


class TestSummaryPrintsOnEveryExitPath(BaseFinalizeTest):
    def test_summary_prints_with_real_zero_counters_on_preflight_abort(self):
        self.w3.eth.chain_id = 196
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            exit_code = finalize.main([])
        output = buffer.getvalue()
        self.assertEqual(exit_code, 1)
        self.assertIn("GRIDFLEX finalize summary", output)
        self.assertEqual(count_field("Finalized:", output), 0)
        self.assertEqual(count_field("Failed (skipped, this reading):", output), 0)

    def test_check_mode_abort_does_not_print_the_reading_summary(self):
        self.w3.eth.chain_id = 196
        with patch.object(finalize, "load_finalizer_account", return_value=MagicMock(address="0xF")):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                exit_code = finalize.main(["--check"])
        self.assertEqual(exit_code, 1)
        self.assertNotIn("GRIDFLEX finalize summary", buffer.getvalue())

    def test_verify_refuses_wrong_chain_without_the_reading_summary(self):
        self.w3.eth.chain_id = 196
        with tempfile.TemporaryDirectory() as directory:
            table_path = write_demo_table(Path(directory), DEMO_TABLE_OK)
            with patch.object(finalize, "DEMO_MARKETS_PATH", table_path):
                buffer = io.StringIO()
                with contextlib.redirect_stdout(buffer):
                    exit_code = finalize.main(["--verify"])
        self.assertEqual(exit_code, 1)
        self.assertNotIn("GRIDFLEX finalize summary", buffer.getvalue())


class TestDryRunAndLiveConfirmation(BaseFinalizeTest):
    def setUp(self):
        super().setUp()
        self.readings = [make_reading(day_key=20260908, value=100)]
        self.w3.eth.get_transaction_count.return_value = 10
        self.w3.eth.gas_price = 20_000_000
        self.w3.eth.get_balance.return_value = 10**18

    def test_dry_run_is_the_default_and_never_prompts(self):
        with patch.object(finalize, "collect_readings", return_value=(self.readings, [])), \
                patch.object(finalize, "chain_reading", return_value=None), \
                patch.object(finalize, "load_ledger", return_value={}), \
                patch.object(finalize, "save_ledger"), \
                patch("builtins.input", side_effect=AssertionError("dry run must not prompt")):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                exit_code = finalize.main([])
        self.assertIn("DRY RUN ONLY", buffer.getvalue())
        self.assertEqual(exit_code, 0)

    def test_live_without_typed_yes_cancels_and_sends_nothing(self):
        now = 1_800_000_000
        current = chain_row(100, "11" * 32, now - 4000, False)
        with patch.object(finalize, "collect_readings", return_value=(self.readings, [])), \
                patch.object(finalize, "chain_reading", return_value=current), \
                patch.object(finalize.time, "time", return_value=now), \
                patch.object(finalize, "ledger_entry_from_chain", return_value={"status": "confirmed"}), \
                patch.object(finalize, "load_ledger", return_value={}), \
                patch.object(finalize, "save_ledger"), \
                patch.object(finalize, "load_finalizer_account", return_value=MagicMock(address="0xF")), \
                patch.object(finalize, "attempt_finalize") as mock_attempt, \
                patch("builtins.input", return_value="no"):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                exit_code = finalize.main(["--live"])
        mock_attempt.assert_not_called()
        self.assertIn("Cancelled", buffer.getvalue())
        self.assertEqual(exit_code, 0)

    def test_nothing_to_finalize_skips_key_loading_and_confirmation(self):
        with patch.object(finalize, "collect_readings", return_value=(self.readings, [])), \
                patch.object(finalize, "chain_reading", return_value=None), \
                patch.object(finalize, "load_ledger", return_value={}), \
                patch.object(finalize, "save_ledger"), \
                patch.object(finalize, "load_finalizer_account") as mock_load_account, \
                patch("builtins.input", side_effect=AssertionError("must not prompt")):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                exit_code = finalize.main(["--live"])
        mock_load_account.assert_not_called()
        self.assertIn("Nothing to finalize", buffer.getvalue())
        self.assertEqual(exit_code, 0)


class TestWaitingReadingNeverFinalized(BaseFinalizeTest):
    def test_reading_inside_dispute_window_is_reported_and_never_sent(self):
        now = 1_800_000_000
        reading = make_reading(day_key=20260924, value=100)
        current = chain_row(100, "11" * 32, now - 900, False)  # 900s in, window is 3600s
        with patch.object(finalize, "collect_readings", return_value=([reading], [])), \
                patch.object(finalize, "chain_reading", return_value=current), \
                patch.object(finalize.time, "time", return_value=now), \
                patch.object(finalize, "ledger_entry_from_chain", return_value={"status": "confirmed"}), \
                patch.object(finalize, "load_ledger", return_value={}), \
                patch.object(finalize, "save_ledger"), \
                patch.object(finalize, "attempt_finalize") as mock_attempt:
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                exit_code = finalize.main([])
        output = buffer.getvalue()
        mock_attempt.assert_not_called()
        self.assertIn("WAITING", output)
        self.assertIn("remaining", output)
        self.assertIn("eligible at", output)
        self.assertEqual(count_field("Not yet eligible (skipped):", output), 1)
        self.assertEqual(count_field("Finalized:", output), 0)
        self.assertEqual(exit_code, 0)


class TestAlreadyFinalizedSkippedSilently(BaseFinalizeTest):
    def test_already_finalized_reading_produces_no_per_reading_line(self):
        now = 1_800_000_000
        reading = make_reading(day_key=20260908, value=100)
        current = chain_row(100, "11" * 32, now - 10_000, True)
        with patch.object(finalize, "collect_readings", return_value=([reading], [])), \
                patch.object(finalize, "chain_reading", return_value=current), \
                patch.object(finalize.time, "time", return_value=now), \
                patch.object(finalize, "ledger_entry_from_chain", return_value={"status": "finalized"}), \
                patch.object(finalize, "load_ledger", return_value={}), \
                patch.object(finalize, "save_ledger"):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                exit_code = finalize.main([])
        output = buffer.getvalue()
        self.assertNotIn(str(reading.day_key), output)
        self.assertEqual(count_field("Already finalized (skipped):", output), 1)
        self.assertEqual(exit_code, 0)


class TestValueMismatchBlocksFinalization(BaseFinalizeTest):
    def test_value_mismatch_is_reported_blocked_and_counted_as_failed(self):
        now = 1_800_000_000
        reading = make_reading(day_key=20260908, value=100)
        current = chain_row(999, "11" * 32, now - 10_000, False)  # value differs
        with patch.object(finalize, "collect_readings", return_value=([reading], [])), \
                patch.object(finalize, "chain_reading", return_value=current), \
                patch.object(finalize.time, "time", return_value=now), \
                patch.object(finalize, "ledger_entry_from_chain", return_value={"status": "confirmed"}), \
                patch.object(finalize, "load_ledger", return_value={}), \
                patch.object(finalize, "save_ledger"), \
                patch.object(finalize, "attempt_finalize") as mock_attempt:
            buffer_out = io.StringIO()
            buffer_err = io.StringIO()
            with contextlib.redirect_stdout(buffer_out), contextlib.redirect_stderr(buffer_err):
                exit_code = finalize.main([])
        mock_attempt.assert_not_called()
        self.assertIn("VALUE MISMATCH", buffer_err.getvalue())
        self.assertEqual(count_field("Failed (skipped, this reading):", buffer_out.getvalue()), 1)
        self.assertEqual(exit_code, 1)

    def test_source_hash_only_drift_does_not_block_finalization(self):
        now = 1_800_000_000
        reading = make_reading(day_key=20260908, value=100, source_hash="11" * 32)
        current = chain_row(100, "22" * 32, now - 10_000, False)  # only hash differs
        with patch.object(finalize, "collect_readings", return_value=([reading], [])), \
                patch.object(finalize, "chain_reading", return_value=current), \
                patch.object(finalize.time, "time", return_value=now), \
                patch.object(finalize, "ledger_entry_from_chain", return_value={"status": "confirmed"}), \
                patch.object(finalize, "load_ledger", return_value={}), \
                patch.object(finalize, "save_ledger"), \
                patch("builtins.input", side_effect=AssertionError("dry run must not prompt")):
            buffer_out = io.StringIO()
            buffer_err = io.StringIO()
            with contextlib.redirect_stdout(buffer_out), contextlib.redirect_stderr(buffer_err):
                exit_code = finalize.main([])
        self.assertNotIn("VALUE MISMATCH", buffer_err.getvalue())
        self.assertEqual(count_field("Would finalize:", buffer_out.getvalue()), 1)
        self.assertEqual(exit_code, 0)


class TestEligibilityIgnoresLedgerCache(BaseFinalizeTest):
    """finalize-spec.md §2: eligibility must come from a fresh getReading()
    call, never from the ledger's cached publishedAt."""

    def test_stale_ledger_publishedat_does_not_make_a_waiting_reading_eligible(self):
        now = 1_800_000_000
        reading = make_reading(day_key=20260924, value=100)
        # The ledger (deliberately stale/wrong) claims this was published long
        # enough ago to be finalizable; the fresh chain read says otherwise.
        stale_ledger = {
            reading.ledger_key: {
                "value": reading.value,
                "sourceHash": reading.source_hash,
                "status": "confirmed",
                "publishedAt": now - 999_999,
            }
        }
        current = chain_row(100, "11" * 32, now - 100, False)  # published 100s ago, window 3600s
        with patch.object(finalize, "collect_readings", return_value=([reading], [])), \
                patch.object(finalize, "chain_reading", return_value=current), \
                patch.object(finalize.time, "time", return_value=now), \
                patch.object(finalize, "ledger_entry_from_chain", return_value={"status": "confirmed"}), \
                patch.object(finalize, "load_ledger", return_value=stale_ledger), \
                patch.object(finalize, "save_ledger"), \
                patch.object(finalize, "attempt_finalize") as mock_attempt:
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                exit_code = finalize.main([])
        mock_attempt.assert_not_called()
        self.assertEqual(count_field("Not yet eligible (skipped):", buffer.getvalue()), 1)
        self.assertEqual(exit_code, 0)


class TestChainRefusal(BaseFinalizeTest):
    def test_check_mode_refuses_wrong_chain(self):
        self.w3.eth.chain_id = 196
        with patch.object(finalize, "load_finalizer_account", return_value=MagicMock(address="0xF")):
            buffer = io.StringIO()
            with contextlib.redirect_stderr(buffer):
                with contextlib.redirect_stdout(io.StringIO()):
                    exit_code = finalize.main(["--check"])
        self.assertEqual(exit_code, 1)
        self.assertIn("Wrong chain", buffer.getvalue())

    def test_default_run_refuses_wrong_chain(self):
        self.w3.eth.chain_id = 196
        buffer = io.StringIO()
        with contextlib.redirect_stderr(buffer):
            with contextlib.redirect_stdout(io.StringIO()):
                exit_code = finalize.main([])
        self.assertEqual(exit_code, 1)
        self.assertIn("Wrong chain", buffer.getvalue())

    def test_refuses_missing_contract_code(self):
        self.w3.eth.get_code.return_value = b""
        buffer = io.StringIO()
        with contextlib.redirect_stderr(buffer):
            with contextlib.redirect_stdout(io.StringIO()):
                exit_code = finalize.main([])
        self.assertEqual(exit_code, 1)
        self.assertIn("No contract bytecode", buffer.getvalue())


if __name__ == "__main__":
    unittest.main()
