"""The request guards on direct fetch_ercot.py and build_candles.py runs.

refresh_data.sh is not the only way to spend the GridStatus allowance: a
direct run of either fetcher is. Both plan every request from the raw cache
before sending one, print the plan (--plan makes no API call at all), can
report the allowance with a single get_api_usage() call (--usage), and stop
before the first data request when the plan needs more than --max-requests.
No network: the client is a mock and the cache a temp directory.
"""

import io
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

import build_candles
import fetch_ercot
import refresh_budget

TODAY = date(2026, 9, 22)
DA = "ercot_spp_day_ahead_hourly"


class CacheTest(unittest.TestCase):
    """A temp raw cache and metrics dir, empty unless a test fills them."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.raw, self.metrics = root / "raw", root / "metrics"
        self.raw.mkdir()
        self.metrics.mkdir()
        self.patches = [
            patch.object(fetch_ercot, "RAW_DIR", self.raw),
            patch.object(fetch_ercot, "METRICS_DIR", self.metrics),
            patch.object(fetch_ercot, "utc_today", return_value=TODAY),
            patch.object(fetch_ercot, "get_client"),
            patch.object(fetch_ercot, "fetch"),
            patch.object(build_candles, "get_client"),
            patch.object(build_candles, "fetch"),
            patch.object(build_candles, "OUT_DIR", root / "candles"),
        ]
        self.mocks = [p.start() for p in self.patches]
        self.get_client = self.mocks[3]
        self.fetch = self.mocks[4]
        self.candles_get_client = self.mocks[5]
        self.candles_fetch = self.mocks[6]

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def cache_final_days(self, dataset, location, first, last):
        """Cache one day file per day in [first, last], as a settled run leaves them."""
        day = first
        while day <= last:
            fetch_ercot.chunk_path(dataset, location, str(day), str(day + timedelta(days=1))).write_text("[]")
            day += timedelta(days=1)

    def run_fetch(self, *argv):
        out = io.StringIO()
        with patch("sys.argv", ["fetch_ercot.py", *argv]), redirect_stdout(out):
            fetch_ercot.main()
        return out.getvalue()

    def run_candles(self, *argv):
        out = io.StringIO()
        with patch("sys.argv", ["build_candles.py", *argv]), \
                patch.object(build_candles, "datetime") as dt, redirect_stdout(out):
            dt.now.return_value.date.return_value = TODAY
            build_candles.main()
        return out.getvalue()


class TestPlanning(CacheTest):
    def test_the_plan_is_the_request_list_fetch_would_send(self):
        plan = fetch_ercot.plan_fetch(DA, "HB_NORTH", "2026-09-19", "2026-09-23", TODAY)
        self.assertEqual(plan["spans"], [("2026-09-19", "2026-09-23")])
        self.assertEqual(plan["requests"], 1)
        self.assertEqual(plan["rows"], 4 * fetch_ercot.ROWS_PER_DAY[DA])

    def test_cached_final_days_cost_nothing(self):
        self.cache_final_days(DA, "HB_NORTH", date(2026, 9, 1), date(2026, 9, 18))
        plan = fetch_ercot.plan_fetch(DA, "HB_NORTH", "2026-09-01", "2026-09-19", TODAY)
        self.assertEqual(plan, {"dataset": DA, "location": "HB_NORTH", "spans": [],
                                "requests": 0, "rows": 0})

    def test_a_year_is_one_request_per_month(self):
        plan = fetch_ercot.plan_fetch(DA, "HB_NORTH", "2025-09-10", "2026-09-23", TODAY)
        self.assertEqual(plan["requests"], 13)

    def test_tomorrow_is_one_more_day_in_the_plan(self):
        start, end = fetch_ercot.fetch_window(3, today=TODAY, include_tomorrow=True)
        plan = fetch_ercot.plan_fetch(DA, "HB_NORTH", str(start), str(end), TODAY)
        self.assertEqual(plan["spans"], [("2026-09-19", "2026-09-24")])
        self.assertEqual(plan["rows"], 5 * fetch_ercot.ROWS_PER_DAY[DA])

    def test_feed_metrics_add_the_eight_feed_reads_in_fetch_order(self):
        reads = fetch_ercot.planned_reads("2026-09-19", "2026-09-23", feed_metrics=True, fuel_mix=True)
        self.assertEqual([(d, loc) for d, loc, _, _ in reads], [
            (DA, "HB_NORTH"),
            (DA, "HB_WEST"),
            ("ercot_spp_real_time_15_min", "HB_WEST"),
            (DA, "LZ_NORTH"), (DA, "LZ_SOUTH"), (DA, "LZ_WEST"), (DA, "LZ_HOUSTON"),
            ("ercot_load_by_forecast_zone", None),
            ("ercot_fuel_mix", None),
        ])

    def test_every_planned_dataset_has_a_row_ceiling(self):
        datasets = {d for d, *_ in fetch_ercot.planned_reads("2026-09-19", "2026-09-23", True, True)}
        datasets |= {build_candles.DATASET, build_candles.FIVE_MIN_DATASET}
        self.assertTrue(datasets <= set(fetch_ercot.ROWS_PER_DAY))

    def test_refresh_budget_plans_with_the_same_planner(self):
        self.assertIs(refresh_budget.ROWS_PER_DAY, fetch_ercot.ROWS_PER_DAY)
        plan = {p["dataset"]: p for p in refresh_budget.plan_refresh(TODAY)}
        direct = fetch_ercot.plan_fetch(
            DA, "HB_NORTH", *map(str, fetch_ercot.fetch_window(3, fill_gaps=True, today=TODAY)), TODAY)
        self.assertEqual(plan[DA], direct)


class TestFetchErcotGuards(CacheTest):
    def test_plan_makes_no_api_call(self):
        out = self.run_fetch("--plan", "--days", "3")
        self.get_client.assert_not_called()
        self.fetch.assert_not_called()
        self.assertIn("this run: 1 request(s), ~100 rows", out)  # 4 days x 25

    def test_plan_includes_tomorrow(self):
        out = self.run_fetch("--plan", "--days", "3", "--tomorrow")
        self.assertIn("2026-09-19 -> 2026-09-24", out)
        self.assertIn("this run: 1 request(s), ~125 rows", out)  # 5 days x 25, tomorrow included

    def test_usage_makes_only_the_usage_request(self):
        client = MagicMock()
        client.get_api_usage.return_value = {
            "limits": {"api_requests_limit": 250, "api_rows_returned_limit": 500_000},
            "current_period_usage": {"total_requests": 100, "total_api_rows_returned": 200_000},
        }
        self.get_client.return_value = client
        with patch.object(fetch_ercot.time, "sleep"):
            out = self.run_fetch("--usage", "--days", "3")
        client.get_api_usage.assert_called_once_with()
        client.get_dataset.assert_not_called()
        self.fetch.assert_not_called()
        self.assertEqual(client.max_retries, 0)
        self.assertIn("requests 150 of 250 left", out)
        self.assertIn("rows 300,000 of 500,000 left", out)

    def test_an_unreadable_usage_answer_is_an_error_not_a_pass(self):
        client = MagicMock()
        client.get_api_usage.return_value = {"something": "else"}
        self.get_client.return_value = client
        with patch.object(fetch_ercot.time, "sleep"), self.assertRaises(SystemExit):
            self.run_fetch("--usage")
        self.fetch.assert_not_called()

    def test_a_run_over_the_limit_stops_before_fetching(self):
        # A year of feed metrics is well over the default of 10 requests.
        with self.assertRaises(SystemExit) as stop:
            self.run_fetch("--days", "400", "--feed-metrics")
        self.assertIn("Refusing to fetch", str(stop.exception))
        self.assertIn("--max-requests 10", str(stop.exception))
        self.get_client.assert_not_called()
        self.fetch.assert_not_called()

    def test_the_default_limit_is_ten(self):
        self.assertEqual(fetch_ercot.DEFAULT_MAX_REQUESTS, 10)

    def test_raising_the_limit_on_purpose_lets_the_run_through(self):
        self.fetch.return_value = (MagicMock(), "hash", ["file.json"])
        with patch.object(fetch_ercot, "day_ahead_average", return_value={}), \
                patch.object(fetch_ercot, "published_readings", return_value={}):
            self.run_fetch("--days", "400", "--max-requests", "20")
        self.get_client.assert_called_once()
        self.fetch.assert_called_once()

    def test_a_routine_run_is_under_the_default_limit(self):
        self.fetch.return_value = (MagicMock(), "hash", ["file.json"])
        with patch.object(fetch_ercot, "day_ahead_average", return_value={}), \
                patch.object(fetch_ercot, "published_readings", return_value={}):
            self.run_fetch("--days", "3", "--fill-gaps", "--tomorrow")
        self.fetch.assert_called_once()

    def test_a_limit_below_one_is_refused(self):
        with self.assertRaises(SystemExit), patch("sys.stderr", io.StringIO()):
            self.run_fetch("--max-requests", "0")
        self.fetch.assert_not_called()


class TestBuildCandlesGuards(CacheTest):
    def test_plan_makes_no_api_call(self):
        out = self.run_candles("--plan")
        self.candles_get_client.assert_not_called()
        self.candles_fetch.assert_not_called()
        self.assertIn(build_candles.FIVE_MIN_DATASET, out)
        self.assertIn(build_candles.DATASET, out)

    def test_a_cold_cache_full_history_stops_before_fetching(self):
        with self.assertRaises(SystemExit) as stop:
            self.run_candles()
        self.assertIn("Refusing to fetch", str(stop.exception))
        self.candles_fetch.assert_not_called()

    def test_a_warm_cache_refresh_is_two_requests_and_runs(self):
        for dataset in (build_candles.DATASET, build_candles.FIVE_MIN_DATASET):
            self.cache_final_days(dataset, "HB_NORTH", date(2025, 9, 1), TODAY - timedelta(days=3))
            # Settled months are cached whole, as fetch() leaves them.
            for s, e in fetch_ercot.month_chunks("2025-09-10", "2026-09-01"):
                fetch_ercot.chunk_path(dataset, "HB_NORTH", s, e).write_text("[]")
        out = self.run_candles("--plan")
        self.assertIn("this run: 2 request(s)", out)

    def test_usage_makes_only_the_usage_request(self):
        client = MagicMock()
        client.get_api_usage.return_value = {
            "limits": {"api_requests_limit": 250, "api_rows_returned_limit": 500_000},
            "current_period_usage": {"total_requests": 100, "total_api_rows_returned": 200_000},
        }
        self.candles_get_client.return_value = client
        with patch.object(fetch_ercot.time, "sleep"):
            out = self.run_candles("--usage")
        client.get_api_usage.assert_called_once_with()
        self.candles_fetch.assert_not_called()
        self.assertIn("GridStatus allowance", out)


if __name__ == "__main__":
    unittest.main()
