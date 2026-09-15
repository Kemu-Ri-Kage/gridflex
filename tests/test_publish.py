import argparse
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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


if __name__ == "__main__":
    unittest.main()
