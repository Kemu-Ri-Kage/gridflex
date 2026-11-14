"""scripts/validate_metrics.py (audit finding S7): the range band and the
provenance gate. sourceHash must reproduce from data/raw/<sourceFiles> in
order, and the value from those raw rows by fetch_ercot's own function."""

import net_guard  # noqa: F401  (tests never reach the network)

import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts import validate_metrics as vm  # noqa: E402

# 22 Sep 2026 is a CDT day: Central midnight is 05:00 UTC.
START = 1790053200
DAY = 20260922
RAW_NAME = "ercot_spp_day_ahead_hourly__HB_NORTH__2026-09-22__2026-09-23.json"


def raw_rows(prices):
    rows = []
    for hour, price in enumerate(prices):
        start = START + hour * 3600
        rows.append({"interval_start_utc": _iso(start), "interval_end_utc": _iso(start + 3600),
                     "location": "HB_NORTH", "spp": price})
    return rows


def _iso(ts):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")


class ProvenanceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.raw = self.tmp / "raw"
        self.raw.mkdir()
        self.metrics = self.tmp / "metrics"
        self.metrics.mkdir()
        payload = json.dumps(raw_rows([40.0] * 23 + [63.0])).encode()
        (self.raw / RAW_NAME).write_bytes(payload)
        self.value = int(round((40.0 * 23 + 63.0) / 24 * 100))   # 4096
        self.hash = hashlib.sha256(payload).hexdigest()

    def metric(self, **overrides):
        record = {"metricId": "ERCOT_HBNORTH_DA_AVG", "dayKey": DAY, "marketDay": "2026-09-22",
                  "marketDayStartUtc": START, "marketDayEndUtc": START + 86400, "value": self.value,
                  "sourceHash": self.hash, "sourceFiles": [RAW_NAME], "hashAlgorithm": "sha256",
                  "hoursUsed": 24}
        record.update(overrides)
        path = self.metrics / "ERCOT_HBNORTH_DA_AVG__2026-09-22.json"
        path.write_text(json.dumps(record))
        return path

    def test_a_reproducible_file_passes(self):
        vm.verify_provenance(self.metric(), self.raw)

    def test_a_missing_raw_file_is_refused(self):
        (self.raw / RAW_NAME).unlink()
        with self.assertRaisesRegex(vm.ProvenanceError, "^PROVENANCE: .*missing"):
            vm.verify_provenance(self.metric(), self.raw)

    def test_a_hash_mismatch_is_refused(self):
        with self.assertRaisesRegex(vm.ProvenanceError, "does not reproduce"):
            vm.verify_provenance(self.metric(sourceHash="cd" * 32), self.raw)

    def test_a_tampered_raw_file_is_refused(self):
        (self.raw / RAW_NAME).write_bytes(json.dumps(raw_rows([90.0] * 24)).encode())
        with self.assertRaisesRegex(vm.ProvenanceError, "does not reproduce"):
            vm.verify_provenance(self.metric(), self.raw)

    def test_a_value_that_does_not_follow_from_the_raw_rows_is_refused(self):
        # The hash matches (it covers the raw bytes), the value was edited.
        with self.assertRaisesRegex(vm.ProvenanceError, "recomputed from raw"):
            vm.verify_provenance(self.metric(value=self.value + 1), self.raw)

    def test_a_path_escaping_the_raw_cache_is_refused(self):
        with self.assertRaisesRegex(vm.ProvenanceError, "not a raw cache file"):
            vm.verify_provenance(self.metric(sourceFiles=["../../etc/passwd"]), self.raw)

    def test_a_derived_metric_cannot_be_traced_and_is_refused(self):
        path = self.metrics / "ERCOT_WEST_NORTH_DA_BASIS__2026-09-22.json"
        record = json.loads(self.metric().read_text())
        record["metricId"] = "ERCOT_WEST_NORTH_DA_BASIS"
        path.write_text(json.dumps(record))
        with self.assertRaisesRegex(vm.ProvenanceError, "no reproducible sourceHash"):
            vm.verify_provenance(path, self.raw)

    def test_the_command_line_checks_files_range_and_provenance(self):
        path = self.metric()
        self.assertEqual(vm.main(["--files", str(path), "--range-min", "-5000", "--range-max", "100000",
                                  "--provenance", "--raw-dir", str(self.raw)]), 0)
        self.assertEqual(vm.main(["--files", str(path), "--range-min", "-5000", "--range-max", "4000"]), 1)
        (self.raw / RAW_NAME).unlink()
        self.assertEqual(vm.main(["--files", str(path), "--provenance", "--raw-dir", str(self.raw)]), 1)

    def test_range_bounds_go_together(self):
        self.assertEqual(vm.main(["--files", str(self.metric()), "--range-min", "0"]), 2)

    def test_the_range_applies_to_price_metrics_only(self):
        path = self.metrics / "ERCOT_HBWEST_NEG_INTERVALS__2026-09-22.json"
        path.write_text(json.dumps({"metricId": "ERCOT_HBWEST_NEG_INTERVALS", "value": 10**6}))
        vm.check_range(path, -5000, 100000)
        with self.assertRaisesRegex(ValueError, "outside"):
            vm.check_range(self.metric(value=100001), -5000, 100000)


if __name__ == "__main__":
    unittest.main()
