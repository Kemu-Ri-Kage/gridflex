import argparse
import contextlib
import hashlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import pandas as pd

import verify_reading
from publish import EXPECTED_CHAIN_ID

ADDRESSES = {
    "chainId": EXPECTED_CHAIN_ID,
    "oracle": "0x0000000000000000000000000000000000000001",
    "factory": "0x0000000000000000000000000000000000000002",
    "collateral": "0x0000000000000000000000000000000000000003",
}
HASH = "75999d0173983de904ad23e09e4b2de1536fa0929e23ae4700359d53593913c4"
COMMITTED = {
    "metricId": "ERCOT_HBNORTH_DA_AVG",
    "dayKey": 20260908,
    "value": 3957,
    "sourceHash": HASH,
    "sourceFiles": ["a.json", "b.json"],
}


def chain_tuple(value=3957, source_hash=HASH, published_at=1_700_000_000, finalized=True):
    return (
        b"\x00" * 32, 20260908, 1788843600, 1788930000, value,
        bytes.fromhex(source_hash), published_at, finalized,
    )


def make_w3(reading=None, chain_id=EXPECTED_CHAIN_ID):
    w3 = MagicMock()
    w3.eth.chain_id = chain_id
    call = w3.eth.contract.return_value.functions.getReading.return_value.call
    call.return_value = reading if reading is not None else chain_tuple(published_at=0)
    return w3


def hourly_frame(day: str, prices):
    """24 hourly rows shaped like GridStatus's day-ahead response, Central day `day`."""
    start = pd.Timestamp(f"{day} 00:00", tz="US/Central").tz_convert("UTC")
    rows = []
    for i, price in enumerate(prices):
        t = start + pd.Timedelta(hours=i)
        rows.append({
            "interval_start_utc": t.isoformat(),
            "interval_end_utc": (t + pd.Timedelta(hours=1)).isoformat(),
            "location": "HB_NORTH",
            "spp": price,
        })
    return pd.DataFrame(rows)


class TestDayKey(unittest.TestCase):
    def test_accepts_a_real_date_and_round_trips(self):
        self.assertEqual(verify_reading.parse_day_key("20260908"), 20260908)
        self.assertEqual(verify_reading.day_key_date(20260908).isoformat(), "2026-09-08")

    def test_rejects_an_impossible_date(self):
        for text in ("20261301", "2026090", "abc", "20260231"):
            with self.assertRaises(argparse.ArgumentTypeError, msg=text):
                verify_reading.parse_day_key(text)


class TestSourceHash(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.raw = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def write(self, name: str, content: bytes) -> None:
        (self.raw / name).write_bytes(content)

    def test_plain_metric_hashes_the_listed_files_in_order(self):
        self.write("ercot_spp_day_ahead_hourly__HB_NORTH__a.json", b"one")
        self.write("ercot_spp_day_ahead_hourly__HB_NORTH__b.json", b"two")
        files = [
            "ercot_spp_day_ahead_hourly__HB_NORTH__a.json",
            "ercot_spp_day_ahead_hourly__HB_NORTH__b.json",
        ]
        expected = hashlib.sha256(b"onetwo").hexdigest()
        self.assertEqual(
            verify_reading.recompute_source_hash("ERCOT_HBNORTH_DA_AVG", files, self.raw),
            expected,
        )
        # The order in sourceFiles is the order that counts.
        self.assertNotEqual(
            verify_reading.recompute_source_hash("ERCOT_HBNORTH_DA_AVG", files[::-1], self.raw),
            expected,
        )

    def test_basis_combines_the_leg_digests_west_first(self):
        self.write("ercot_spp_day_ahead_hourly__HB_WEST__a.json", b"west")
        self.write("ercot_spp_day_ahead_hourly__HB_NORTH__a.json", b"north")
        files = [
            "ercot_spp_day_ahead_hourly__HB_WEST__a.json",
            "ercot_spp_day_ahead_hourly__HB_NORTH__a.json",
        ]
        west = hashlib.sha256(b"west").hexdigest()
        north = hashlib.sha256(b"north").hexdigest()
        self.assertEqual(
            verify_reading.recompute_source_hash("ERCOT_WEST_NORTH_DA_BASIS", files, self.raw),
            hashlib.sha256((west + north).encode()).hexdigest(),
        )

    def test_a_missing_raw_file_means_skip_not_a_wrong_hash(self):
        self.write("ercot_spp_day_ahead_hourly__HB_NORTH__a.json", b"one")
        files = [
            "ercot_spp_day_ahead_hourly__HB_NORTH__a.json",
            "ercot_spp_day_ahead_hourly__HB_NORTH__missing.json",
        ]
        self.assertIsNone(
            verify_reading.recompute_source_hash("ERCOT_HBNORTH_DA_AVG", files, self.raw)
        )


class TestRecomputeFromGridStatus(unittest.TestCase):
    def test_day_ahead_average_matches_the_pipeline_rule(self):
        prices = [10.0] * 12 + [50.0] * 12   # mean 30.00 -> 3000
        frame = hourly_frame("2026-09-08", prices)
        with patch.object(verify_reading.fetch_ercot, "fetch_span", return_value=frame):
            value, notes = verify_reading.recompute_from_gridstatus(
                MagicMock(), "ERCOT_HBNORTH_DA_AVG", verify_reading.day_key_date(20260908)
            )
        self.assertEqual(value, 3000)
        self.assertTrue(any("24 hourly rows" in note for note in notes))

    def test_an_incomplete_day_recomputes_to_nothing(self):
        frame = hourly_frame("2026-09-08", [10.0] * 23)
        with patch.object(verify_reading.fetch_ercot, "fetch_span", return_value=frame):
            value, _ = verify_reading.recompute_from_gridstatus(
                MagicMock(), "ERCOT_HBNORTH_DA_AVG", verify_reading.day_key_date(20260908)
            )
        self.assertIsNone(value)


class TestRun(unittest.TestCase):
    def run_verify(self, w3, committed=COMMITTED, fetch=False):
        args = argparse.Namespace(
            metric="ERCOT_HBNORTH_DA_AVG", day_key=20260908, fetch=fetch,
            raw_dir=Path(tempfile.gettempdir()) / "gridflex-no-raw-here",
        )
        out = io.StringIO()
        with patch.object(verify_reading, "load_addresses", return_value=ADDRESSES), \
             patch.object(verify_reading, "make_web3", return_value=w3), \
             patch.object(verify_reading, "load_abi", return_value=[]), \
             patch.object(verify_reading, "load_metric_file", return_value=committed), \
             contextlib.redirect_stdout(out):
            report = verify_reading.run(args)
        return report, out.getvalue()

    def test_matching_chain_and_file_pass_and_raw_files_are_skipped_not_failed(self):
        report, out = self.run_verify(make_w3(chain_tuple()))
        self.assertFalse(report.failed)
        self.assertIn("PASS chain vs file", "\n".join(report.lines))
        self.assertIn("SKIP sourceHash", "\n".join(report.lines))
        self.assertIn("finalized", out)

    def test_a_different_chain_value_fails(self):
        report, _ = self.run_verify(make_w3(chain_tuple(value=3958)))
        self.assertTrue(report.failed)
        self.assertIn("value differs", "\n".join(report.lines))

    def test_nothing_published_is_a_skip(self):
        report, out = self.run_verify(make_w3())
        self.assertFalse(report.failed)
        self.assertIn("nothing published", out)

    def test_wrong_chain_is_refused(self):
        with self.assertRaises(verify_reading.PublisherError):
            self.run_verify(make_w3(chain_tuple(), chain_id=196))


if __name__ == "__main__":
    unittest.main()
