"""refresh_budget.py: what one refresh costs, and refusing one that won't fit.

The plan is worked out from the raw cache alone; the allowance check makes
exactly one get_api_usage() call and nothing else. No network: the client is
a mock.
"""

import io
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

import build_candles
import fetch_ercot
import refresh_budget

TODAY = date(2026, 9, 22)
DA = "ercot_spp_day_ahead_hourly"
RT = "ercot_spp_real_time_15_min"
LMP = "ercot_lmp_by_settlement_point"

USAGE = {
    "limits": {"api_requests_limit": 250, "api_rows_returned_limit": 500_000,
               "per_second_api_rate_limit": 1},
    "current_usage_period_start": "2026-09-01T00:00:00Z",
    "current_usage_period_end": "2026-10-01T00:00:00Z",
    "current_period_usage": {"total_requests": 100, "total_api_rows_returned": 200_000},
}


def usage(requests_used=100, rows_used=200_000, requests_limit=250, rows_limit=500_000):
    return {**USAGE,
            "limits": {**USAGE["limits"], "api_requests_limit": requests_limit,
                       "api_rows_returned_limit": rows_limit},
            "current_period_usage": {"total_requests": requests_used,
                                     "total_api_rows_returned": rows_used}}


class CacheTest(unittest.TestCase):
    """A temp raw cache holding what a routine refresh finds: every final
    day and month cached, for all three datasets, and a complete
    day-ahead metric file for every day before the recent window."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.raw, self.metrics = root / "raw", root / "metrics"
        self.raw.mkdir()
        self.metrics.mkdir()
        self.patches = [patch.object(fetch_ercot, "RAW_DIR", self.raw),
                        patch.object(fetch_ercot, "METRICS_DIR", self.metrics)]
        for p in self.patches:
            p.start()
        self.fill_cache(until=TODAY - timedelta(days=fetch_ercot.RECENT_DAYS))
        self.write_metrics(date(2026, 9, 1), TODAY - timedelta(days=fetch_ercot.RECENT_DAYS))

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def fill_cache(self, until):
        for dataset, location, start, end in refresh_budget.refresh_windows(TODAY):
            for s, e in fetch_ercot.plan_chunks(dataset, location, start, end, TODAY):
                if date.fromisoformat(e) <= until:
                    fetch_ercot.chunk_path(dataset, location, s, e).write_text("[]")

    def write_metrics(self, first, until):
        day = first
        while day < until:
            (self.metrics / f"ERCOT_HBNORTH_DA_AVG__{day}.json").write_text("{}")
            day += timedelta(days=1)

    def plan(self, **kwargs):
        return {item["dataset"]: item for item in refresh_budget.plan_refresh(TODAY, **kwargs)}


class TestPlan(CacheTest):
    def test_a_routine_refresh_is_three_requests(self):
        plan = self.plan()
        self.assertEqual(set(plan), {DA, RT, LMP})
        self.assertEqual({d: p["requests"] for d, p in plan.items()}, {DA: 1, RT: 1, LMP: 1})
        self.assertTrue(all(p["location"] == "HB_NORTH" for p in plan.values()))

    def test_it_reads_the_recent_days_and_for_day_ahead_today(self):
        plan = self.plan()
        self.assertEqual(plan[DA]["spans"], [("2026-09-19", "2026-09-23")])
        self.assertEqual(plan[RT]["spans"], [("2026-09-19", "2026-09-22")])
        self.assertEqual(plan[LMP]["spans"], [("2026-09-19", "2026-09-22")])

    def test_rows_are_budgeted_at_the_per_day_ceiling(self):
        plan = self.plan()
        self.assertEqual(plan[DA]["rows"], 4 * 25)
        self.assertEqual(plan[RT]["rows"], 3 * 100)
        self.assertEqual(plan[LMP]["rows"], 3 * 300)

    def test_a_missed_week_is_still_one_day_ahead_request(self):
        for path in self.metrics.glob("*__2026-09-1[2-8].json"):
            path.unlink()
        for path in self.raw.glob(f"{DA}__*__2026-09-1[2-8]__*.json"):
            path.unlink()
        plan = self.plan()
        self.assertEqual(plan[DA]["spans"], [("2026-09-12", "2026-09-23")])
        self.assertEqual(plan[DA]["requests"], 1)
        self.assertEqual(plan[DA]["rows"], 11 * 25)

    def test_a_span_longer_than_a_page_costs_a_request_per_page(self):
        self.assertEqual(self.plan(rows_per_page=250)[LMP]["requests"], 4)

    def test_it_plans_the_windows_the_fetchers_use(self):
        windows = {d: (s, e) for d, _, s, e in refresh_budget.refresh_windows(TODAY)}
        self.assertEqual(windows[DA], tuple(str(d) for d in fetch_ercot.fetch_window(
            refresh_budget.REFRESH_DAYS, fill_gaps=True, today=TODAY)))
        candles = build_candles.fetch_windows(TODAY)
        self.assertEqual(windows[RT], candles[RT])
        self.assertEqual(windows[LMP], candles[LMP])


class TestReadAllowance(unittest.TestCase):
    def test_reads_limits_and_usage(self):
        self.assertEqual(refresh_budget.read_allowance(usage()), {
            "requests_limit": 250, "requests_used": 100,
            "rows_limit": 500_000, "rows_used": 200_000, "rows_per_page": None})

    def test_minus_one_is_no_limit(self):
        allowance = refresh_budget.read_allowance(usage(requests_limit=-1))
        self.assertIsNone(allowance["requests_limit"])

    def test_reads_a_per_response_row_limit(self):
        answer = usage()
        answer["limits"]["api_rows_per_response_limit"] = 50_000
        self.assertEqual(refresh_budget.read_allowance(answer)["rows_per_page"], 50_000)

    def test_an_answer_without_a_request_limit_is_refused(self):
        answer = usage()
        del answer["limits"]["api_requests_limit"]
        with self.assertRaisesRegex(ValueError, "requests_limit"):
            refresh_budget.read_allowance(answer)

    def test_an_unrecognised_answer_is_refused(self):
        with self.assertRaises(ValueError):
            refresh_budget.read_allowance({"requests_today": 4})


class TestCheck(unittest.TestCase):
    PLAN = [{"requests": 1, "rows": 100}, {"requests": 1, "rows": 300},
            {"requests": 1, "rows": 900}]

    def check(self, **kwargs):
        return refresh_budget.check(self.PLAN, refresh_budget.read_allowance(usage(**kwargs)))

    def test_fits(self):
        self.assertEqual(self.check(), [])

    def test_exactly_fits(self):
        self.assertEqual(self.check(requests_used=247, rows_used=500_000 - 1_300), [])

    def test_too_few_requests_left(self):
        [problem] = self.check(requests_used=248)
        self.assertIn("needs 3 requests, 2 left", problem)

    def test_over_the_request_limit_already(self):
        [problem] = self.check(requests_used=375)
        self.assertIn("needs 3 requests, 0 left (375 of 250 used)", problem)

    def test_too_few_rows_left(self):
        [problem] = self.check(rows_used=499_000)
        self.assertIn("needs 1,300 rows, 1,000 left", problem)

    def test_no_limit_always_fits(self):
        self.assertEqual(self.check(requests_limit=-1, requests_used=10**6), [])

    def check_lifted(self, **kwargs):
        return refresh_budget.check(self.PLAN, refresh_budget.read_allowance(usage(**kwargs)),
                                    requests_lifted=True)

    def test_requests_lifted_skips_the_request_check(self):
        self.assertEqual(self.check_lifted(requests_used=375), [])

    def test_requests_lifted_still_checks_rows(self):
        [problem] = self.check_lifted(requests_used=375, rows_used=499_000)
        self.assertIn("needs 1,300 rows, 1,000 left", problem)


class TestMain(CacheTest):
    def run_main(self, answer=None, error=None, argv=()):
        client = MagicMock()
        if error:
            client.get_api_usage.side_effect = error
        else:
            client.get_api_usage.return_value = answer
        out, err = io.StringIO(), io.StringIO()
        with patch.object(fetch_ercot, "get_client", return_value=client), \
                patch.object(refresh_budget.time, "sleep"), \
                patch.object(fetch_ercot, "utc_today", return_value=TODAY), \
                redirect_stdout(out), redirect_stderr(err):
            code = refresh_budget.main(list(argv))
        return code, client, out.getvalue(), err.getvalue()

    def test_room_left_passes_with_one_usage_call_and_no_data_request(self):
        code, client, out, _ = self.run_main(usage())
        self.assertEqual(code, 0)
        client.get_api_usage.assert_called_once_with()
        client.get_dataset.assert_not_called()
        self.assertEqual(client.max_retries, 0)
        self.assertIn("one refresh: 3 request(s), ~1,300 rows", out)

    def test_over_the_limit_refuses(self):
        code, client, _, err = self.run_main(usage(requests_used=375))
        self.assertEqual(code, 1)
        self.assertIn("Refusing to refresh", err)
        client.get_dataset.assert_not_called()

    def test_a_failed_usage_call_refuses(self):
        code, _, _, err = self.run_main(error=Exception("HTTP 429: limit"))
        self.assertEqual(code, 1)
        self.assertIn("get_api_usage() failed", err)

    def test_an_unreadable_usage_answer_refuses(self):
        code, _, _, err = self.run_main({"something": "else"})
        self.assertEqual(code, 1)
        self.assertIn("Refusing to refresh", err)

    def test_requests_lifted_passes_over_the_request_limit(self):
        code, client, out, err = self.run_main(
            usage(requests_used=375, rows_used=378_000), argv=["--requests-lifted"])
        self.assertEqual(code, 0, err)
        client.get_api_usage.assert_called_once_with()
        client.get_dataset.assert_not_called()
        self.assertIn("one refresh: 3 request(s), ~1,300 rows", out)
        self.assertIn("requests 375 used, cap lifted", out)
        self.assertIn("rows 122,000 of 500,000 left", out)

    def test_requests_lifted_still_refuses_too_few_rows(self):
        code, client, _, err = self.run_main(
            usage(requests_used=375, rows_used=499_000), argv=["--requests-lifted"])
        self.assertEqual(code, 1)
        self.assertIn("needs 1,300 rows, 1,000 left", err)
        self.assertNotIn("needs 3 requests", err)
        client.get_dataset.assert_not_called()

    def test_requests_lifted_still_refuses_an_unreadable_answer(self):
        code, _, _, err = self.run_main({"something": "else"}, argv=["--requests-lifted"])
        self.assertEqual(code, 1)
        self.assertIn("Refusing to refresh", err)

    def test_plan_only_makes_no_call(self):
        with patch.object(fetch_ercot, "get_client") as get_client, \
                patch.object(fetch_ercot, "utc_today", return_value=TODAY), \
                redirect_stdout(io.StringIO()):
            self.assertEqual(refresh_budget.main(["--plan"]), 0)
        get_client.assert_not_called()


if __name__ == "__main__":
    unittest.main()
