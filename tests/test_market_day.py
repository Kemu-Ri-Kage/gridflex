"""
Tests for the market-day identity scheme that replaced periodStart/periodEnd:
dayKey (YYYYMMDD int), marketDay (ISO string), marketDayStartUtc/EndUtc
(true UTC instants).

The bug being guarded against: periodStart used to be midnight UTC of the
Central calendar date, which is NOT the same instant as Central midnight —
for 8 September it was 2026-09-08 00:00 UTC, which is actually 2026-09-07
19:00 Central. Converting periodStart back to Central landed on the wrong
day. dayKey can't have that problem because it's a bare integer, not an
instant; marketDayStartUtc/EndUtc are real instants but are the correct
ones, computed from the actual interval boundaries in the data instead of
assumed as a fixed 86400-second span.

Run:
    python3 -m unittest tests.test_market_day -v
"""

import os
import sys
import unittest
from datetime import date

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fetch_ercot import CENTRAL, day_bounds_from_df, day_key  # noqa: E402


def hourly_day_df(central_date_str):
    """
    Synthetic hourly (day-ahead-shaped) rows for exactly one Central
    calendar day. start/end are derived by localizing the two surrounding
    Central midnights and generating hourly UTC timestamps between them —
    not by hand-picking a row count — so a spring-forward day comes out 23
    rows and a fall-back day comes out 25, the same way the real GridStatus
    feed does, without the test having to assert its own assumption into
    existence.
    """
    midnight = pd.Timestamp(f"{central_date_str} 00:00:00")
    start_utc = midnight.tz_localize(CENTRAL).tz_convert("UTC")
    end_utc = (midnight + pd.Timedelta(days=1)).tz_localize(CENTRAL).tz_convert("UTC")
    idx = pd.date_range(start_utc, end_utc, freq="h", inclusive="left")
    return pd.DataFrame({
        "interval_start_utc": idx,
        "interval_end_utc": idx + pd.Timedelta(hours=1),
        "spp": range(len(idx)),
    })


def date_from_day_key(k):
    return date(k // 10000, (k // 100) % 100, k % 100)


class TestDayKeyRoundTrip(unittest.TestCase):
    """dayKey is a bare YYYYMMDD integer with no timezone attached to it.
    Reconstructing a date from it involves no conversion at all -- that's
    the whole point: there is no instant to misinterpret, so there is no
    day it can shift by, in any timezone, ever."""

    def test_round_trips_for_ordinary_and_dst_dates(self):
        dates = [
            date(2026, 9, 8),
            date(2026, 3, 8),    # spring-forward
            date(2025, 11, 2),   # fall-back
            date(2026, 1, 1),
            date(2026, 12, 31),
        ]
        for d in dates:
            with self.subTest(d=d):
                self.assertEqual(date_from_day_key(day_key(d)), d)

    def test_matches_the_real_regression_case(self):
        # The exact case from the bug report: dayKey for 8 September 2026
        # must read back as 8 September, not 7 September.
        d = date(2026, 9, 8)
        self.assertEqual(day_key(d), 20260908)
        self.assertEqual(date_from_day_key(20260908), d)


class TestMarketDayBounds(unittest.TestCase):
    def test_normal_day_starts_and_ends_at_central_midnight(self):
        d = date(2026, 9, 8)
        df = hourly_day_df("2026-09-08")
        start_utc, end_utc = day_bounds_from_df(df)[d]

        start_central = pd.Timestamp(start_utc, unit="s", tz="UTC").tz_convert(CENTRAL)
        end_central = pd.Timestamp(end_utc, unit="s", tz="UTC").tz_convert(CENTRAL)

        self.assertEqual(start_central.date(), d)
        self.assertEqual((start_central.hour, start_central.minute), (0, 0))
        self.assertEqual(end_central.date(), date(2026, 9, 9))
        self.assertEqual((end_central.hour, end_central.minute), (0, 0))
        self.assertEqual((end_utc - start_utc) / 3600, 24)

    def test_marketDayStartUtc_lands_on_the_same_date_as_dayKey(self):
        """
        The core promise of the fix. Take marketDayStartUtc, convert it to
        Central time, read off the calendar date -- it must be the exact
        same date dayKey encodes. This is precisely the check that would
        have failed under the old periodStart scheme (UTC midnight of the
        Central date converts back to 7pm the *previous* Central day).
        """
        for day_str in ("2026-09-08", "2026-03-08", "2025-11-02"):
            with self.subTest(day=day_str):
                d = date.fromisoformat(day_str)
                df = hourly_day_df(day_str)
                start_utc, _ = day_bounds_from_df(df)[d]

                start_central_date = (
                    pd.Timestamp(start_utc, unit="s", tz="UTC")
                    .tz_convert(CENTRAL)
                    .date()
                )
                self.assertEqual(start_central_date, d)
                self.assertEqual(start_central_date, date_from_day_key(day_key(d)))

    def test_spring_forward_day_is_23_hours(self):
        # 2026-03-08: Central time skips 02:00-03:00, so the calendar day
        # genuinely has 23 hours in it, not 24.
        d = date(2026, 3, 8)
        df = hourly_day_df("2026-03-08")
        self.assertEqual(len(df), 23)
        start_utc, end_utc = day_bounds_from_df(df)[d]
        self.assertEqual((end_utc - start_utc) / 3600, 23)

    def test_fall_back_day_is_25_hours(self):
        # 2025-11-02: Central time repeats 01:00-02:00, so the calendar day
        # genuinely has 25 hours in it, not 24.
        d = date(2025, 11, 2)
        df = hourly_day_df("2025-11-02")
        self.assertEqual(len(df), 25)
        start_utc, end_utc = day_bounds_from_df(df)[d]
        self.assertEqual((end_utc - start_utc) / 3600, 25)

    def test_old_bug_is_actually_gone(self):
        """
        Directly reproduces what was wrong with periodStart: midnight UTC
        of the Central calendar date is not the same instant as Central
        midnight. Assert marketDayStartUtc is NOT that old, wrong value.
        """
        d = date(2026, 9, 8)
        df = hourly_day_df("2026-09-08")
        start_utc, _ = day_bounds_from_df(df)[d]

        old_wrong_period_start = int(
            pd.Timestamp("2026-09-08 00:00:00", tz="UTC").timestamp()
        )
        self.assertNotEqual(start_utc, old_wrong_period_start)

        # And that old value really does land on the wrong Central day,
        # which is exactly the bug this fix removes.
        old_value_in_central = (
            pd.Timestamp(old_wrong_period_start, unit="s", tz="UTC")
            .tz_convert(CENTRAL)
        )
        self.assertEqual(old_value_in_central.date(), date(2026, 9, 7))


if __name__ == "__main__":
    unittest.main()
