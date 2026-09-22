"""fetch_ercot.py's request budget, --plan dry run and HTTP request count.

The GridStatus free plan meters requests as well as rows (250 requests a
month at the time of writing), and one refresh with the old per-day
fetching pattern spent 40-odd of them. These tests pin the guards that
stop that happening again: a run knows how many requests it is about to
make before it makes them, refuses to go past its budget, and counts the
HTTP requests actually sent rather than the get_dataset calls made.
"""

import io
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import date
from pathlib import Path
from unittest.mock import MagicMock, patch

import pandas as pd

import fetch_ercot


class BudgetBase(unittest.TestCase):
    TODAY = date(2026, 9, 22)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        raw = Path(self.tmp.name) / "raw"
        self.patches = [
            patch.object(fetch_ercot, "RAW_DIR", raw),
            patch.object(fetch_ercot, "SUPERSEDED_DIR", raw / "superseded"),
            patch.object(fetch_ercot.time, "sleep"),
            patch.object(fetch_ercot, "rows_fetched", 0),
            patch.object(fetch_ercot, "requests_made", 0),
            patch.object(fetch_ercot, "http_requests", 0),
            patch.object(fetch_ercot, "request_budget", None),
            patch.object(fetch_ercot, "utc_today", return_value=self.TODAY),
        ]
        for p in self.patches:
            p.start()
        self.raw = raw

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def rows(self, *days):
        starts = []
        for day in days:
            midnight = pd.Timestamp(day).tz_localize("US/Central")
            starts += [midnight, midnight + pd.Timedelta(hours=1)]
        utc = [t.tz_convert("UTC") for t in starts]
        return pd.DataFrame({
            "interval_start_utc": utc,
            "interval_end_utc": [t + pd.Timedelta(hours=1) for t in utc],
            "spp": [1.0] * len(utc),
        })

    def client_returning(self, df):
        client = MagicMock()
        client.get_dataset.return_value = df
        return client


class TestPlanRequests(BudgetBase):
    def test_a_refresh_window_is_one_request_with_no_api_call(self):
        spans = fetch_ercot.plan_requests("ds", "HB_NORTH", "2026-09-19", "2026-09-23")
        self.assertEqual(spans, [("2026-09-19", "2026-09-23")])

    def test_cached_final_days_are_not_requested(self):
        self.raw.mkdir(parents=True)
        for start, end in fetch_ercot.day_chunks("2026-09-10", "2026-09-19"):
            fetch_ercot.chunk_path("ds", "HB_NORTH", start, end).write_text("[]")
        spans = fetch_ercot.plan_requests("ds", "HB_NORTH", "2026-09-10", "2026-09-23")
        self.assertEqual(spans, [("2026-09-19", "2026-09-23")])

    def test_a_long_backfill_is_one_request_per_month(self):
        spans = fetch_ercot.plan_requests("ds", "HB_NORTH", "2026-06-01", "2026-09-01")
        self.assertEqual(len(spans), 3)

    def test_plan_output_names_every_dataset_and_the_total(self):
        out = io.StringIO()
        with redirect_stdout(out):
            fetch_ercot.print_plan("2026-09-19", "2026-09-23")
        text = out.getvalue()
        self.assertIn("Day-ahead prices, HB_NORTH: 1 request(s)", text)
        self.assertIn("would make 1 GridStatus request(s)", text)
        self.assertIn("PLAN ONLY", text)

    def test_plan_with_feed_metrics_lists_all_eight_datasets(self):
        out = io.StringIO()
        with redirect_stdout(out):
            fetch_ercot.print_plan("2026-09-19", "2026-09-23", feed_metrics=True, fuel_mix=True)
        self.assertIn("would make 9 GridStatus request(s)", out.getvalue())


class TestRequestBudget(BudgetBase):
    def test_no_budget_means_no_limit(self):
        client = self.client_returning(self.rows("2026-09-22"))
        fetch_ercot.fetch(client, "ds", "2026-09-19", "2026-09-23", location="HB_NORTH")
        self.assertEqual(client.get_dataset.call_count, 1)

    def test_a_run_over_budget_stops_before_sending(self):
        fetch_ercot.request_budget = 2
        client = self.client_returning(self.rows("2026-06-01"))
        with self.assertRaises(SystemExit) as raised:
            # Three settled, uncached months: three requests, budget of two.
            fetch_ercot.fetch(client, "ds", "2026-06-01", "2026-09-01", location="HB_NORTH")
        self.assertIn("over the budget of 2", str(raised.exception))
        client.get_dataset.assert_not_called()

    def test_the_budget_counts_across_datasets_in_one_run(self):
        fetch_ercot.request_budget = 1
        client = self.client_returning(self.rows("2026-09-22"))
        fetch_ercot.fetch(client, "ds", "2026-09-19", "2026-09-23", location="HB_NORTH")
        with self.assertRaises(SystemExit):
            fetch_ercot.fetch(client, "ds2", "2026-09-19", "2026-09-23", location="HB_NORTH")
        self.assertEqual(client.get_dataset.call_count, 1)

    def test_a_fully_cached_run_never_trips_the_budget(self):
        fetch_ercot.request_budget = 0  # would be "no limit" from the CLI; here it's zero
        self.raw.mkdir(parents=True)
        fetch_ercot.chunk_path("ds", "HB_NORTH", "2026-07-01", "2026-08-01").write_text(
            '[{"interval_start_utc":"2026-07-01T05:00:00Z","interval_end_utc":"2026-07-01T06:00:00Z","spp":1.0}]'
        )
        client = self.client_returning(self.rows())
        fetch_ercot.fetch(client, "ds", "2026-07-01", "2026-08-01", location="HB_NORTH")
        client.get_dataset.assert_not_called()


class TestHttpRequestCount(unittest.TestCase):
    def test_every_page_counts_as_a_request(self):
        client = MagicMock()
        pages = []
        client.get.side_effect = lambda *a, **k: pages.append(1)
        with patch.object(fetch_ercot, "http_requests", 0):
            fetch_ercot.count_http_requests(client)
            client.get("u")
            client.get("u", params={"page": 2})
            self.assertEqual(fetch_ercot.http_requests, 2)
        self.assertEqual(len(pages), 2)

    def test_usage_summary_reads_the_documented_fields(self):
        client = MagicMock()
        client.get_api_usage.return_value = {
            "plan_name": "Free",
            "limits": {"api_rows_returned_limit": 500_000, "api_rows_per_response_limit": 10_000},
            "current_period_usage": {"total_api_rows_returned": 12_345, "total_requests": 375},
        }
        summary = fetch_ercot.api_usage(client)
        self.assertEqual(summary["plan"], "Free")
        self.assertEqual(summary["requests_used"], 375)
        self.assertEqual(summary["rows_used"], 12_345)
        self.assertEqual(summary["rows_limit"], 500_000)
        out = io.StringIO()
        with redirect_stdout(out):
            fetch_ercot.print_usage(client)
        self.assertIn("requests this period: 375", out.getvalue())


if __name__ == "__main__":
    unittest.main()
