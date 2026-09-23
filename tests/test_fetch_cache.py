"""The raw-cache freshness rule, and what a refresh may and may not rewrite.

A chunk is only trusted from cache once its data can no longer change; a
re-fetched chunk never destroys bytes a published hash was computed from;
and a reading already onchain is never rewritten by a later run.
"""

import hashlib
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
            patch.object(fetch_ercot, "requests_made", 0),
        ]
        for p in self.patches:
            p.start()
        self.raw = raw

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    TODAY = date(2026, 9, 22)

    def rows(self, *days, per_day=2, price=1.0):
        """A GridStatus-shaped frame: per_day rows on each Central day."""
        starts = []
        for day in days:
            midnight = pd.Timestamp(day).tz_localize("US/Central")
            starts += [midnight + pd.Timedelta(hours=h) for h in range(per_day)]
        utc = [t.tz_convert("UTC") for t in starts]
        return pd.DataFrame({
            "interval_start_utc": utc,
            "interval_end_utc": [t + pd.Timedelta(hours=1) for t in utc],
            "spp": [price] * len(utc),
        })

    def client_returning(self, df):
        client = MagicMock()
        client.get_dataset.return_value = df
        return client

    def fetch(self, client, start, end):
        with patch.object(fetch_ercot, "utc_today", return_value=self.TODAY):
            return fetch_ercot.fetch(client, "ds", start, end, location="HB_NORTH")

    def path(self, start, end):
        return fetch_ercot.chunk_path("ds", "HB_NORTH", start, end)

    def cache(self, start, end, text='[{"spp":1.0}]'):
        self.raw.mkdir(parents=True, exist_ok=True)
        self.path(start, end).write_text(text)

    def requested(self, client):
        return [(c.kwargs["start"], c.kwargs["end"]) for c in client.get_dataset.call_args_list]

    def test_a_final_cached_range_makes_no_request(self):
        self.cache("2026-07-01", "2026-08-01")
        client = self.client_returning(self.rows())
        df, _, files = self.fetch(client, "2026-07-01", "2026-08-01")
        client.get_dataset.assert_not_called()
        self.assertEqual(df["spp"].tolist(), [1.0])
        self.assertEqual(files, ["ds__HB_NORTH__2026-07-01__2026-08-01.json"])
        self.assertEqual((fetch_ercot.rows_fetched, fetch_ercot.requests_made), (0, 0))

    def test_the_recent_days_and_today_are_one_request_split_into_day_files(self):
        client = self.client_returning(self.rows("2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22"))
        df, _, files = self.fetch(client, "2026-09-19", "2026-09-23")
        self.assertEqual(self.requested(client), [("2026-09-19", "2026-09-23")])
        self.assertEqual(files, [f"ds__HB_NORTH__2026-09-{d}__2026-09-{d + 1}.json" for d in range(19, 23)])
        for name in files:
            self.assertEqual(len(json.loads((self.raw / name).read_text())), 2)
        self.assertEqual(len(df), 8)
        self.assertEqual((fetch_ercot.rows_fetched, fetch_ercot.requests_made), (8, 1))

    def test_a_gap_and_the_recent_days_share_one_request(self):
        # 10-18 Sep never fetched, 19-21 cached but still recent, 22 is today.
        for day in (19, 20, 21):
            self.cache(f"2026-09-{day}", f"2026-09-{day + 1}")
        days = [f"2026-09-{d}" for d in range(10, 23)]
        client = self.client_returning(self.rows(*days))
        _, _, files = self.fetch(client, "2026-09-10", "2026-09-23")
        self.assertEqual(self.requested(client), [("2026-09-10", "2026-09-23")])
        self.assertEqual(len(files), 13)
        self.assertEqual(fetch_ercot.requests_made, 1)

    def test_a_cached_final_day_inside_the_span_is_never_rewritten(self):
        self.cache("2026-09-12", "2026-09-13", '[{"spp":7.0}]')
        client = self.client_returning(self.rows(*[f"2026-09-{d}" for d in range(10, 15)], price=2.0))
        df, _, _ = self.fetch(client, "2026-09-10", "2026-09-15")
        self.assertEqual(self.requested(client), [("2026-09-10", "2026-09-15")])
        self.assertEqual(self.path("2026-09-12", "2026-09-13").read_text(), '[{"spp":7.0}]')
        self.assertFalse((self.raw / "superseded").exists())
        self.assertIn(7.0, df["spp"].tolist())

    def test_a_changed_recent_day_keeps_its_previous_bytes(self):
        self.cache("2026-09-21", "2026-09-22", '[{"spp":1.0}]')
        client = self.client_returning(self.rows("2026-09-21", price=5.0))
        self.fetch(client, "2026-09-21", "2026-09-22")
        archived = list((self.raw / "superseded").glob("ds__HB_NORTH__2026-09-21__2026-09-22__*.json"))
        self.assertEqual([p.read_text() for p in archived], ['[{"spp":1.0}]'])

    def test_a_final_day_with_no_rows_is_left_for_the_next_run(self):
        # A gap-filling window: 11 Sep and 13-18 Sep come back empty.
        days = ["2026-09-10", "2026-09-12"] + [f"2026-09-{d}" for d in range(19, 23)]
        client = self.client_returning(self.rows(*days))
        _, _, files = self.fetch(client, "2026-09-10", "2026-09-23")
        self.assertFalse(self.path("2026-09-11", "2026-09-12").exists())
        self.assertEqual(len(files), 6)

    def test_a_recent_day_with_no_rows_yet_is_cached_empty(self):
        client = self.client_returning(self.rows("2026-09-21"))
        _, _, files = self.fetch(client, "2026-09-21", "2026-09-23")
        self.assertEqual(self.path("2026-09-22", "2026-09-23").read_text(), "[]")
        self.assertEqual(len(files), 2)

    def test_the_hash_is_the_chunk_files_in_date_order(self):
        client = self.client_returning(self.rows("2026-09-20", "2026-09-21"))
        _, digest, files = self.fetch(client, "2026-09-20", "2026-09-22")
        expected = hashlib.sha256(b"".join((self.raw / f).read_bytes() for f in files)).hexdigest()
        self.assertEqual(digest, expected)

    def test_a_long_backfill_breaks_at_month_boundaries(self):
        # Nothing cached from 1 Jul: Jul and Aug are whole-month chunks, Sep
        # is days. Three requests, none longer than MAX_REQUEST_DAYS.
        client = self.client_returning(self.rows("2026-07-15", "2026-08-15", "2026-09-15"))
        self.fetch(client, "2026-07-01", "2026-09-23")
        self.assertEqual(self.requested(client), [
            ("2026-07-01", "2026-08-01"), ("2026-08-01", "2026-09-01"), ("2026-09-01", "2026-09-23"),
        ])

    def test_request_spans(self):
        days = fetch_ercot.day_chunks("2026-09-01", "2026-09-23")
        self.assertEqual(fetch_ercot.request_spans(days), [("2026-09-01", "2026-09-23")])
        self.assertEqual(fetch_ercot.request_spans([]), [])
        month_and_days = [("2026-08-01", "2026-09-01")] + days
        self.assertEqual(fetch_ercot.request_spans(month_and_days),
                         [("2026-08-01", "2026-09-01"), ("2026-09-01", "2026-09-23")])

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

    def test_tomorrow_is_included_only_on_request(self):
        # With include_tomorrow the window reaches [19 Sep, 24 Sep): tomorrow,
        # 23 Sep, is the day whose day-ahead prices ERCOT publishes today.
        self.assertEqual(
            fetch_ercot.fetch_window(3, False, self.TODAY, self.metrics, include_tomorrow=True),
            (date(2026, 9, 19), date(2026, 9, 24)))
        # The default is unchanged, so refresh_budget.py's plan still matches.
        self.assertEqual(
            fetch_ercot.fetch_window(3, False, self.TODAY, self.metrics),
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


class TestWhatARefreshFetches(unittest.TestCase):
    """Only what the site and the live markets use, unless asked for more."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.calls = []
        empty = pd.DataFrame({"interval_start_utc": pd.Series(dtype="object"),
                              "interval_end_utc": pd.Series(dtype="object"),
                              "spp": pd.Series(dtype="float64")})

        def fake_fetch(client, dataset, start, end, location=None, tag=""):
            self.calls.append((dataset, location))
            return empty, "hash", []

        self.patches = [
            patch.object(fetch_ercot, "get_client", return_value=MagicMock()),
            patch.object(fetch_ercot, "fetch", side_effect=fake_fetch),
            patch.object(fetch_ercot, "load_weighted_index", return_value={}),
            patch.object(fetch_ercot, "fuel_shares", return_value={}),
            patch.object(fetch_ercot, "METRICS_DIR", Path(self.tmp.name)),
            patch.object(fetch_ercot, "PUBLISH_LEDGER", Path(self.tmp.name) / "none.json"),
            patch("builtins.print"),
        ]
        for one in self.patches:
            one.start()

    def tearDown(self):
        for one in reversed(self.patches):
            one.stop()
        self.tmp.cleanup()

    def run_main(self, *argv):
        with patch("sys.argv", ["fetch_ercot.py", *argv]):
            fetch_ercot.main()
        return self.calls

    def test_a_refresh_fetches_north_hub_day_ahead_only(self):
        self.assertEqual(self.run_main("--days", "3", "--fill-gaps"),
                         [("ercot_spp_day_ahead_hourly", "HB_NORTH")])

    def test_feed_metrics_are_behind_their_own_flag(self):
        calls = self.run_main("--feed-metrics")
        self.assertEqual(calls[0], ("ercot_spp_day_ahead_hourly", "HB_NORTH"))
        self.assertIn(("ercot_spp_day_ahead_hourly", "HB_WEST"), calls)
        self.assertIn(("ercot_spp_real_time_15_min", "HB_WEST"), calls)
        self.assertIn(("ercot_load_by_forecast_zone", None), calls)
        self.assertEqual(sum(1 for d, loc in calls if loc and loc.startswith("LZ_")), 4)
        self.assertNotIn(("ercot_fuel_mix", None), calls)

    def test_fuel_mix_is_behind_its_own_flag(self):
        self.assertIn(("ercot_fuel_mix", None), self.run_main("--fuel-mix"))


class TestWhatTheCandleBuilderFetches(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.calls = []
        ts = pd.date_range("2026-09-20", periods=48, freq="15min", tz="UTC")

        def fake_fetch(client, dataset, start, end, location=None, tag=""):
            self.calls.append((dataset, location))
            column = "lmp" if dataset == build_candles.FIVE_MIN_DATASET else "spp"
            df = pd.DataFrame({"interval_start_utc": ts.astype(str), column: 30.0})
            return df, "hash", ["file.json"]

        self.patches = [
            patch.object(build_candles, "get_client", return_value=MagicMock()),
            patch.object(build_candles, "fetch", side_effect=fake_fetch),
            patch.object(build_candles, "OUT_DIR", Path(self.tmp.name)),
            patch("builtins.print"),
        ]
        for one in self.patches:
            one.start()

    def tearDown(self):
        for one in reversed(self.patches):
            one.stop()
        self.tmp.cleanup()

    def run_main(self, *argv):
        # The plan is made from the real (here: empty) cache, so a full
        # history would trip the request guard; this test is about which
        # datasets are read, not the guard (tests/test_request_budget.py).
        with patch("sys.argv", ["build_candles.py", "--max-requests", "50", *argv]):
            build_candles.main()
        return self.calls

    def test_a_refresh_builds_north_hub_candles_from_two_datasets(self):
        self.assertEqual(self.run_main(), [
            (build_candles.FIVE_MIN_DATASET, "HB_NORTH"),
            (build_candles.DATASET, "HB_NORTH"),
        ])
        self.assertEqual([p.name for p in Path(self.tmp.name).iterdir()], ["HB_NORTH.json"])

    def test_west_hub_is_behind_its_own_flag(self):
        locations = {loc for _, loc in self.run_main("--west-hub")}
        self.assertEqual(locations, {"HB_NORTH", "HB_WEST"})


if __name__ == "__main__":
    unittest.main()
