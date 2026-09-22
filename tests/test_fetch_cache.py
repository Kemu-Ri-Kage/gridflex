"""The raw-cache freshness rule, and what a refresh may and may not rewrite.

A chunk is only trusted from cache once its data can no longer change; a
re-fetched chunk never destroys bytes a published hash was computed from;
and a reading already onchain is never rewritten by a later run.
"""

import json
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

import pandas as pd

import build_candles
import build_feed_data
import fetch_ercot


class TestChunkIsFinal(unittest.TestCase):
    TODAY = date(2026, 9, 22)

    def final(self, start, end, today=TODAY):
        return fetch_ercot.chunk_is_final(start, end, today)

    def test_a_whole_past_month_is_final(self):
        self.assertTrue(self.final("2026-08-01", "2026-09-01"))

    def test_earlier_days_of_the_current_month_are_final(self):
        self.assertTrue(self.final("2026-09-01", "2026-09-02"))
        self.assertTrue(self.final("2026-09-18", "2026-09-19"))

    def test_the_last_three_days_are_never_final(self):
        # Today is 22 Sep: 19, 20 and 21 Sep are the recent days.
        self.assertFalse(self.final("2026-09-19", "2026-09-20"))
        self.assertFalse(self.final("2026-09-21", "2026-09-22"))

    def test_a_past_month_is_final_once_its_last_day_leaves_the_window(self):
        self.assertFalse(self.final("2026-08-01", "2026-09-01", today=date(2026, 9, 3)))
        self.assertTrue(self.final("2026-08-01", "2026-09-01", today=date(2026, 9, 4)))

    def test_a_chunk_ending_in_the_future_is_never_final(self):
        self.assertFalse(self.final("2026-10-01", "2026-10-05"))


class TestPlanChunks(unittest.TestCase):
    TODAY = date(2026, 9, 22)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.raw = Path(self.tmp.name)
        self.patch = patch.object(fetch_ercot, "RAW_DIR", self.raw)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def cache(self, start, end):
        fetch_ercot.chunk_path("ds", "HB_NORTH", start, end).write_text("[]")

    def plan(self, start, end, today=TODAY):
        return fetch_ercot.plan_chunks("ds", "HB_NORTH", start, end, today)

    def test_the_current_month_is_one_chunk_per_day(self):
        plan = self.plan("2026-09-01", "2026-09-22")
        self.assertEqual(len(plan), 21)
        self.assertEqual(plan[0], ("2026-09-01", "2026-09-02"))
        self.assertEqual(plan[-1], ("2026-09-21", "2026-09-22"))

    def test_day_chunk_names_do_not_change_from_one_day_to_the_next(self):
        # Tomorrow's plan reuses every one of today's day files, so a day that
        # leaves the recent window is read from cache, never fetched again.
        today = set(self.plan("2026-09-01", "2026-09-22"))
        tomorrow = set(self.plan("2026-09-01", "2026-09-23", today=date(2026, 9, 23)))
        self.assertTrue(today <= tomorrow)
        self.assertEqual(tomorrow - today, {("2026-09-22", "2026-09-23")})

    def test_a_settled_month_uses_its_cached_whole_month_file(self):
        self.cache("2026-08-01", "2026-09-01")
        self.assertEqual(
            self.plan("2026-08-01", "2026-09-01"), [("2026-08-01", "2026-09-01")]
        )

    def test_a_settled_month_read_day_by_day_keeps_its_day_files(self):
        # September, after it has settled: its days were cached while it ran.
        for start, end in fetch_ercot.day_chunks("2026-09-01", "2026-10-01"):
            if start != "2026-09-15":
                self.cache(start, end)
        plan = self.plan("2026-09-01", "2026-10-01", today=date(2026, 10, 10))
        self.assertEqual(len(plan), 30)
        self.assertIn(("2026-09-15", "2026-09-16"), plan)

    def test_an_uncached_settled_month_is_one_request(self):
        self.assertEqual(
            self.plan("2026-07-01", "2026-08-01"), [("2026-07-01", "2026-08-01")]
        )

    def test_a_long_range_mixes_months_and_days(self):
        self.cache("2026-07-01", "2026-08-01")
        plan = self.plan("2026-07-01", "2026-09-22")
        self.assertEqual(plan[:2], [("2026-07-01", "2026-08-01"), ("2026-08-01", "2026-09-01")])
        self.assertEqual(len(plan), 2 + 21)

    def test_refresh_window_is_exactly_the_recent_days(self):
        plan = self.plan("2026-09-19", "2026-09-22")
        self.assertEqual(
            plan,
            [("2026-09-19", "2026-09-20"), ("2026-09-20", "2026-09-21"),
             ("2026-09-21", "2026-09-22")],
        )
        self.assertFalse(any(fetch_ercot.chunk_is_final(s, e, self.TODAY) for s, e in plan))


class TestFetchChunkCache(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        raw = Path(self.tmp.name) / "raw"
        self.patches = [
            patch.object(fetch_ercot, "RAW_DIR", raw),
            patch.object(fetch_ercot, "SUPERSEDED_DIR", raw / "superseded"),
            patch.object(fetch_ercot.time, "sleep"),
            patch.object(fetch_ercot, "rows_fetched", 0),
        ]
        for p in self.patches:
            p.start()
        self.raw = raw

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def client_returning(self, prices):
        client = MagicMock()
        client.get_dataset.return_value = pd.DataFrame({"spp": prices})
        return client

    def test_a_final_cached_chunk_is_read_without_any_request(self):
        self.raw.mkdir(parents=True)
        (self.raw / "ds__HB_NORTH__2026-07-01__2026-08-01.json").write_text('[{"spp":1.0}]')
        client = self.client_returning([9.0])
        df, _ = fetch_ercot.fetch_chunk(client, "ds", "2026-07-01", "2026-08-01", "HB_NORTH")
        client.get_dataset.assert_not_called()
        self.assertEqual(df["spp"].tolist(), [1.0])
        self.assertEqual(fetch_ercot.rows_fetched, 0)

    def test_a_recent_cached_chunk_is_refetched_and_counted(self):
        self.raw.mkdir(parents=True)
        path = self.raw / "ds__HB_NORTH__2026-09-21__2026-09-22.json"
        path.write_text('[{"spp":1.0}]')
        client = self.client_returning([1.0, 2.0, 3.0])
        with patch.object(fetch_ercot, "chunk_is_final", return_value=False):
            df, returned = fetch_ercot.fetch_chunk(
                client, "ds", "2026-09-21", "2026-09-22", "HB_NORTH"
            )
        client.get_dataset.assert_called_once()
        self.assertEqual(len(df), 3)
        self.assertEqual(fetch_ercot.rows_fetched, 3)
        self.assertEqual(json.loads(returned.read_text()), [{"spp": 1.0}, {"spp": 2.0}, {"spp": 3.0}])

    def test_changed_bytes_keep_the_previous_version(self):
        self.raw.mkdir(parents=True)
        path = self.raw / "ds__HB_NORTH__2026-09-01__2026-09-22.json"
        path.write_text('[{"spp":1.0}]')
        fetch_ercot.store_chunk(path, '[{"spp":2.0}]')
        archived = list((self.raw / "superseded").glob("ds__HB_NORTH__2026-09-01__2026-09-22__*.json"))
        self.assertEqual(len(archived), 1)
        self.assertEqual(archived[0].read_text(), '[{"spp":1.0}]')
        self.assertEqual(path.read_text(), '[{"spp":2.0}]')

    def test_identical_bytes_archive_nothing(self):
        self.raw.mkdir(parents=True)
        path = self.raw / "ds__HB_NORTH__2026-09-01__2026-09-22.json"
        path.write_text('[{"spp":1.0}]')
        fetch_ercot.store_chunk(path, '[{"spp":1.0}]')
        self.assertFalse((self.raw / "superseded").exists())


class TestPublishedReadingsAreNeverRewritten(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.metrics = Path(self.tmp.name) / "metrics"
        self.metrics.mkdir()
        self.patch = patch.object(fetch_ercot, "METRICS_DIR", self.metrics)
        self.patch.start()
        self.day = date(2026, 9, 8)
        self.path = self.metrics / "ERCOT_HBNORTH_DA_AVG__2026-09-08.json"

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def write(self, value, published):
        return fetch_ercot.write_metric(
            "ERCOT_HBNORTH_DA_AVG", self.day, value, "new-hash", ["new.json"], 1, 2,
            published=published,
        )

    def test_an_unpublished_day_is_written(self):
        self.assertEqual(self.write(3957, published={}), self.path)
        self.assertEqual(json.loads(self.path.read_text())["sourceHash"], "new-hash")

    def test_a_published_day_keeps_its_committed_file(self):
        self.path.write_text(json.dumps({"value": 3957, "sourceHash": "onchain-hash"}))
        published = {"ERCOT_HBNORTH_DA_AVG:20260908": {"value": 3957, "txHash": "0xabc"}}
        self.assertIsNone(self.write(3957, published))
        self.assertEqual(json.loads(self.path.read_text())["sourceHash"], "onchain-hash")

    def test_a_different_recomputed_value_is_warned_about_not_written(self):
        self.path.write_text(json.dumps({"value": 3957, "sourceHash": "onchain-hash"}))
        published = {"ERCOT_HBNORTH_DA_AVG:20260908": {"value": 3957, "txHash": "0xabc"}}
        with patch("builtins.print") as mock_print:
            self.assertIsNone(self.write(4000, published))
        self.assertIn("WARNING", mock_print.call_args.args[0])
        self.assertEqual(json.loads(self.path.read_text())["value"], 3957)

    def test_published_readings_only_counts_submitted_entries(self):
        ledger = Path(self.tmp.name) / "publish-ledger.json"
        ledger.write_text(json.dumps({
            "ERCOT_HBNORTH_DA_AVG:20260908": {"txHash": "0xabc", "value": 3957},
            "ERCOT_HBNORTH_DA_AVG:20260909": {"status": "pending"},
        }))
        with patch.object(fetch_ercot, "PUBLISH_LEDGER", ledger):
            self.assertEqual(list(fetch_ercot.published_readings()), ["ERCOT_HBNORTH_DA_AVG:20260908"])


class TestFiveMinuteWindowStart(unittest.TestCase):
    def test_moves_forward_to_the_next_first_of_month(self):
        # 90 days before 22 Sep is 24 Jun; the window starts 1 Jul.
        self.assertEqual(build_candles.five_min_window_start(date(2026, 9, 22), 90), "2026-07-01")

    def test_is_the_same_all_month_so_its_first_chunks_stay_cached(self):
        starts = {build_candles.five_min_window_start(date(2026, 9, d), 90) for d in range(3, 30)}
        self.assertEqual(starts, {"2026-07-01"})

    def test_keeps_a_start_that_is_already_the_first(self):
        self.assertEqual(build_candles.five_min_window_start(date(2026, 9, 30), 91), "2026-07-01")

    def test_rolls_over_a_year_end(self):
        self.assertEqual(build_candles.five_min_window_start(date(2027, 2, 15), 60), "2027-01-01")


class TestFeedMeta(unittest.TestCase):
    def test_updated_at_is_the_newest_computed_at(self):
        with tempfile.TemporaryDirectory() as directory:
            metrics = Path(directory)
            for day, stamp in (("2026-09-08", "2026-09-10T16:49:17.976219+00:00"),
                               ("2026-09-21", "2026-09-22T11:05:00+00:00"),
                               ("2026-09-09", "2026-09-10T16:49:18+00:00")):
                (metrics / f"ERCOT_HBNORTH_DA_AVG__{day}.json").write_text(
                    json.dumps({"computedAt": stamp})
                )
            (metrics / "ERCOT_WEST_NORTH_DA_BASIS__2026-09-23.json").write_text(
                json.dumps({"computedAt": "2030-01-01T00:00:00+00:00"})
            )
            self.assertEqual(
                build_feed_data.latest_computed_at("ERCOT_HBNORTH_DA_AVG", metrics),
                "2026-09-22T11:05:00Z",
            )

    def test_no_files_gives_none(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(
                build_feed_data.latest_computed_at("ERCOT_HBNORTH_DA_AVG", Path(directory))
            )


class TestFetchWindow(unittest.TestCase):
    """Which market days one run reads: today, the recent days, and gaps."""

    TODAY = date(2026, 9, 22)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.metrics = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def have(self, *days, metric="ERCOT_HBNORTH_DA_AVG"):
        for day in days:
            (self.metrics / f"{metric}__{day}.json").write_text("{}")

    def have_range(self, first, last):
        day = first
        while day <= last:
            if not fetch_ercot.is_dst_changeover(day):
                self.have(day)
            day += timedelta(days=1)

    def window(self, days=3, fill_gaps=True):
        return fetch_ercot.fetch_window(days, fill_gaps, self.TODAY, self.metrics)

    def test_today_is_included(self):
        # end is exclusive: [19 Sep, 23 Sep) is 19, 20, 21 and today, 22 Sep.
        self.assertEqual(self.window(fill_gaps=False),
                         (date(2026, 9, 19), date(2026, 9, 23)))

    def test_the_current_gap_is_filled(self):
        # The state the audit found: files up to 9 Sep, then 19-21 Sep.
        self.have_range(date(2026, 9, 1), date(2026, 9, 9))
        self.have_range(date(2026, 9, 19), date(2026, 9, 21))
        self.assertEqual(fetch_ercot.latest_complete_day("ERCOT_HBNORTH_DA_AVG", self.metrics),
                         date(2026, 9, 9))
        self.assertEqual(self.window(), (date(2026, 9, 10), date(2026, 9, 23)))

    def test_no_gap_leaves_the_recent_window_alone(self):
        self.have_range(date(2026, 9, 1), date(2026, 9, 21))
        self.assertEqual(self.window(), (date(2026, 9, 19), date(2026, 9, 23)))

    def test_a_run_missed_for_a_week_is_filled(self):
        # No gap inside the files, but nothing after 10 Sep.
        self.have_range(date(2026, 9, 1), date(2026, 9, 10))
        self.assertEqual(self.window()[0], date(2026, 9, 11))

    def test_gap_filling_is_off_unless_asked_for(self):
        self.have_range(date(2026, 9, 1), date(2026, 9, 9))
        self.assertEqual(self.window(fill_gaps=False)[0], date(2026, 9, 19))

    def test_dst_changeover_days_are_not_gaps(self):
        # 8 Mar 2026 (23h) and 1 Nov 2026 (25h) never get a metric file.
        self.assertTrue(fetch_ercot.is_dst_changeover(date(2026, 3, 8)))
        self.assertTrue(fetch_ercot.is_dst_changeover(date(2025, 11, 2)))
        self.assertFalse(fetch_ercot.is_dst_changeover(date(2026, 9, 10)))
        self.have_range(date(2026, 3, 1), date(2026, 3, 15))
        self.assertEqual(fetch_ercot.latest_complete_day("ERCOT_HBNORTH_DA_AVG", self.metrics),
                         date(2026, 3, 15))

    def test_other_metrics_do_not_decide_the_gap(self):
        # Negative-interval days go missing upstream for good; they must not
        # drag every future run back to them.
        self.have_range(date(2026, 9, 1), date(2026, 9, 21))
        self.have(date(2026, 9, 1), date(2026, 9, 21), metric="ERCOT_HBWEST_NEG_INTERVALS")
        self.assertEqual(self.window()[0], date(2026, 9, 19))

    def test_no_metric_files_at_all(self):
        self.assertIsNone(fetch_ercot.latest_complete_day("ERCOT_HBNORTH_DA_AVG", self.metrics))
        self.assertEqual(self.window()[0], date(2026, 9, 19))

    def test_gap_days_come_from_the_cache_once_fetched(self):
        # Gap days are older than the recent window: fetched once, then final.
        self.assertTrue(fetch_ercot.chunk_is_final("2026-09-10", "2026-09-11", self.TODAY))
        self.assertFalse(fetch_ercot.chunk_is_final("2026-09-22", "2026-09-23", self.TODAY))


if __name__ == "__main__":
    unittest.main()
