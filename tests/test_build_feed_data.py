import json
import tempfile
import unittest
from pathlib import Path

import pandas as pd

import build_feed_data
import publish


def make_reading(
    metric_id: str = "ERCOT_HBNORTH_DA_AVG",
    day_key: int = 20260908,
    value: int = 3957,
    source_hash: str = "11" * 32,
) -> publish.MetricReading:
    return publish.MetricReading(
        path=Path(f"{metric_id}__{day_key}.json"),
        metric_id=metric_id,
        day_key=day_key,
        market_day_start_utc=1,
        market_day_end_utc=2,
        value=value,
        source_hash=source_hash,
    )


class TestMarketDayFromDayKey(unittest.TestCase):
    def test_string_slices_without_any_timezone_conversion(self):
        # feed-spec.md §9: this must be pure digit-slicing, exactly like
        # oracle-interface.md sanctions - never datetime/timezone arithmetic.
        self.assertEqual(build_feed_data.market_day_from_day_key(20260908), "2026-09-08")


class TestAggregate(unittest.TestCase):
    def test_correct_join_when_a_ledger_entry_exists(self):
        reading = make_reading()
        ledger = {reading.ledger_key: {"txHash": "0xabc123", "status": "confirmed"}}
        by_metric = build_feed_data.aggregate([reading], ledger)
        records = by_metric[reading.metric_id]
        self.assertEqual(len(records), 1)
        self.assertEqual(
            records[0],
            {
                "dayKey": 20260908,
                "marketDay": "2026-09-08",
                "value": 3957,
                "sourceHash": "11" * 32,
                "txHash": "0xabc123",
            },
        )

    def test_metric_day_with_no_ledger_entry_gets_a_null_tx_hash(self):
        reading = make_reading(day_key=20260909)
        by_metric = build_feed_data.aggregate([reading], ledger={})
        records = by_metric[reading.metric_id]
        self.assertEqual(len(records), 1)
        self.assertIsNone(records[0]["txHash"])
        # every other field still passes through untouched
        self.assertEqual(records[0]["value"], reading.value)
        self.assertEqual(records[0]["sourceHash"], reading.source_hash)

    def test_ledger_entry_present_but_missing_tx_hash_key_is_also_null(self):
        reading = make_reading(day_key=20260910)
        ledger = {reading.ledger_key: {"status": "submitted"}}  # no txHash yet
        by_metric = build_feed_data.aggregate([reading], ledger)
        self.assertIsNone(by_metric[reading.metric_id][0]["txHash"])

    def test_empty_metric_set_yields_an_empty_list_for_every_in_scope_metric(self):
        by_metric = build_feed_data.aggregate([], ledger={})
        self.assertEqual(set(by_metric.keys()), set(publish.EXPECTED_METRICS))
        for records in by_metric.values():
            self.assertEqual(records, [])

    def test_readings_are_sorted_by_day_key_within_a_metric(self):
        readings = [
            make_reading(day_key=20260910),
            make_reading(day_key=20260908),
            make_reading(day_key=20260909),
        ]
        by_metric = build_feed_data.aggregate(readings, ledger={})
        day_keys = [r["dayKey"] for r in by_metric["ERCOT_HBNORTH_DA_AVG"]]
        self.assertEqual(day_keys, [20260908, 20260909, 20260910])

    def test_readings_for_different_metrics_are_kept_separate(self):
        readings = [
            make_reading(metric_id="ERCOT_HBNORTH_DA_AVG", day_key=20260908),
            make_reading(metric_id="ERCOT_WEST_NORTH_DA_BASIS", day_key=20260908, value=-1032),
        ]
        by_metric = build_feed_data.aggregate(readings, ledger={})
        self.assertEqual(len(by_metric["ERCOT_HBNORTH_DA_AVG"]), 1)
        self.assertEqual(len(by_metric["ERCOT_WEST_NORTH_DA_BASIS"]), 1)
        self.assertEqual(by_metric["ERCOT_WEST_NORTH_DA_BASIS"][0]["value"], -1032)


class TestWriteAggregates(unittest.TestCase):
    def test_writes_one_file_per_metric_including_empty_ones(self):
        by_metric = {name: [] for name in publish.EXPECTED_METRICS}
        by_metric["ERCOT_HBNORTH_DA_AVG"] = [
            {
                "dayKey": 20260908,
                "marketDay": "2026-09-08",
                "value": 3957,
                "sourceHash": "11" * 32,
                "txHash": "0xabc",
            }
        ]
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            build_feed_data.write_aggregates(out, by_metric)
            for metric_id in publish.EXPECTED_METRICS:
                path = out / f"{metric_id}.json"
                self.assertTrue(path.exists(), f"{path} was not written")
            written = json.loads((out / "ERCOT_HBNORTH_DA_AVG.json").read_text())
            self.assertEqual(written, by_metric["ERCOT_HBNORTH_DA_AVG"])
            empty_written = json.loads((out / "ERCOT_WEST_NORTH_DA_BASIS.json").read_text())
            self.assertEqual(empty_written, [])


class TestWriteAddresses(unittest.TestCase):
    def test_publishes_market_addresses_and_create_txs_only(self):
        source = {
            "chainId": 1952,
            "GridOracle": "0xoracle",
            "MarketFactory": "0xfactory",
            "MockUSDT": "0xusdt",
            "transactions": {"GridOracle": "0xdeploy"},
            "markets": [
                {
                    "market": "0xmarket",
                    "createTxHash": "0xcreate",
                    "metricId": "ERCOT_HBNORTH_DA_AVG",
                    "dayKey": 20260908,
                    "threshold": 3000,
                }
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_path = root / "addresses.json"
            source_path.write_text(json.dumps(source))
            original = build_feed_data.ADDRESSES_SOURCE
            build_feed_data.ADDRESSES_SOURCE = source_path
            try:
                build_feed_data.write_addresses(root)
            finally:
                build_feed_data.ADDRESSES_SOURCE = original
            written = json.loads((root / "addresses.json").read_text())
        # Strike, day and metric are read from the contract, never republished.
        self.assertEqual(written["markets"], [{"market": "0xmarket", "createTxHash": "0xcreate"}])
        self.assertEqual(written["GridOracleDeployTx"], "0xdeploy")

    def test_no_markets_key_publishes_an_empty_list(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_path = root / "addresses.json"
            source_path.write_text(json.dumps({"chainId": 1952}))
            original = build_feed_data.ADDRESSES_SOURCE
            build_feed_data.ADDRESSES_SOURCE = source_path
            try:
                build_feed_data.write_addresses(root)
            finally:
                build_feed_data.ADDRESSES_SOURCE = original
            written = json.loads((root / "addresses.json").read_text())
        self.assertEqual(written["markets"], [])


def make_hourly_day(prices, first_start_utc="2026-09-09T05:00:00Z"):
    """Hourly rows starting at Central midnight (05:00Z during CDT)."""
    starts = pd.date_range(first_start_utc, periods=len(prices), freq="h", tz="UTC")
    return pd.DataFrame(
        {
            "interval_start_utc": starts.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "interval_end_utc": (starts + pd.Timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "spp": prices,
        }
    )


class TestHourlySwing(unittest.TestCase):
    # 30 every hour except 10 at 04:00 Central and 50 at 18:00 Central:
    # mean is exactly 30.00, published as 3000.
    PRICES = [30.0] * 24
    PRICES[4] = 10.0
    PRICES[18] = 50.0

    def test_cheapest_and_dearest_hour_in_central_time(self):
        swing = build_feed_data.hourly_swing(make_hourly_day(self.PRICES), "2026-09-09", 3000)
        self.assertEqual(swing["cheapest"]["hourStartCentral"], "04:00")
        self.assertEqual(swing["cheapest"]["value"], 1000)
        self.assertEqual(swing["dearest"]["hourStartCentral"], "18:00")
        self.assertEqual(swing["dearest"]["value"], 5000)
        # 04:00 CDT is 09:00 UTC - the instant, not just the label
        self.assertEqual(
            swing["cheapest"]["hourStartUtc"],
            int(pd.Timestamp("2026-09-09T09:00:00Z").timestamp()),
        )

    def test_rows_from_the_neighbouring_day_are_excluded(self):
        # 23:00 Central on the 8th and 00:00 Central on the 10th, both extreme
        hourly = pd.concat(
            [
                make_hourly_day([999.0], "2026-09-09T04:00:00Z"),
                make_hourly_day(self.PRICES),
                make_hourly_day([-999.0], "2026-09-10T05:00:00Z"),
            ],
            ignore_index=True,
        )
        swing = build_feed_data.hourly_swing(hourly, "2026-09-09", 3000)
        self.assertEqual(swing["cheapest"]["value"], 1000)
        self.assertEqual(swing["dearest"]["value"], 5000)

    def test_incomplete_day_is_refused_not_summarised(self):
        with self.assertRaisesRegex(ValueError, "23/24 hours"):
            build_feed_data.hourly_swing(make_hourly_day(self.PRICES[:23]), "2026-09-09", 3000)

    def test_hours_that_do_not_average_to_the_published_value_are_refused(self):
        with self.assertRaisesRegex(ValueError, "does not match"):
            build_feed_data.hourly_swing(make_hourly_day(self.PRICES), "2026-09-09", 3001)


class TestPriceRange(unittest.TestCase):
    def test_middle_eighty_percent_median_and_peak(self):
        # 1..10 dollars plus one 1000-dollar spike, as cents
        values = [100 * n for n in range(1, 11)] + [100_000]
        records = [
            {"dayKey": 20260101 + i, "value": value} for i, value in enumerate(values)
        ]
        result = build_feed_data.price_range(records)
        self.assertEqual(result["days"], 11)
        self.assertEqual(result["firstDayKey"], 20260101)
        self.assertEqual(result["lastDayKey"], 20260111)
        self.assertEqual(result["median"], 600)
        # pandas linear quantiles over 11 points: 10th pct = 200, 90th = 1000
        self.assertEqual(result["low"], 200)
        self.assertEqual(result["high"], 1000)
        self.assertEqual(
            result["peak"], {"dayKey": 20260111, "value": 100_000, "timesMedian": 167}
        )


if __name__ == "__main__":
    unittest.main()
