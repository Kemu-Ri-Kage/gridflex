"""scripts/settle_due.py: what the daily settle job does next, and when it
alerts. The rules live in plan(), which takes plain data, so no RPC is made.
"""

import net_guard  # noqa: F401  (tests never reach the network)
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import settle_due as sd  # noqa: E402

HB = "ERCOT_HBNORTH_DA_AVG"
HOUR = 3600
WINDOW = 3600          # GridOracle dispute window
WEEK = 7 * 24 * HOUR   # the markets' own window before cancel() opens
# 15 Oct 2026 00:30 UTC: the 15 Oct markets closed at 14 Oct 17:30 UTC.
NOW = int(datetime(2026, 10, 15, 0, 30, tzinfo=timezone.utc).timestamp())
CLOSE_15 = int(datetime(2026, 10, 14, 17, 30, tzinfo=timezone.utc).timestamp())


def market(day=20261015, close=CLOSE_15, resolved=False, cancelled=False, address="0xA"):
    return sd.Market(address=address, metric_id=HB, day_key=day, threshold=4000,
                     resolve_after=close, dispute_window=WEEK,
                     resolved=resolved, cancelled=cancelled)


def reading(value=3120, published_at=NOW - 10 * 60, final=False, source_hash="aa" * 32):
    return sd.Reading(value=value, source_hash=source_hash, published_at=published_at, final=final)


def file(value=3120, source_hash="aa" * 32):
    return {"value": value, "sourceHash": source_hash}


def run(markets=(), readings=None, files=None, now=NOW, last=20261020, balances=None):
    files = {(HB, 20261015): file()} if files is None else files
    return sd.plan(list(markets), readings or {}, files, now, WINDOW, last, balances)


class TestNextSteps(unittest.TestCase):
    def test_a_closed_market_with_a_file_and_no_reading_is_published(self):
        result = run([market()])
        self.assertEqual(result["publish"], [{"metricId": HB, "dayKey": 20261015}])
        self.assertEqual((result["publishStart"], result["publishEnd"]), (20261015, 20261015))
        self.assertFalse(result["fetchNeeded"])

    def test_an_open_market_is_not_published(self):
        result = run([market(close=NOW + HOUR)])
        self.assertEqual(result["publish"], [])
        self.assertIsNone(result["publishStart"])

    def test_a_closed_market_without_its_file_needs_a_fetch(self):
        result = run([market()], files={})
        self.assertTrue(result["fetchNeeded"])
        self.assertEqual(result["publish"], [])

    def test_todays_missing_file_needs_a_fetch_even_with_no_market(self):
        self.assertTrue(run([], files={})["fetchNeeded"])

    def test_a_reading_inside_its_dispute_window_waits(self):
        result = run([market()], readings={(HB, 20261015): reading(published_at=NOW - 600)})
        self.assertEqual(result["finalize"], [])
        self.assertEqual(result["secondsToFinalizable"], WINDOW - 600)
        self.assertEqual(result["publish"], [])

    def test_a_reading_past_its_window_is_finalized(self):
        result = run([market()], readings={(HB, 20261015): reading(published_at=NOW - WINDOW - 5)})
        self.assertEqual(result["finalize"], [{"metricId": HB, "dayKey": 20261015}])
        self.assertEqual(result["finalizeStart"], 20261015)
        self.assertEqual(result["secondsToFinalizable"], 0)

    def test_nothing_waiting_gives_no_finalize_time(self):
        self.assertIsNone(run([market()])["secondsToFinalizable"])

    def test_a_final_reading_makes_the_market_resolvable(self):
        result = run([market(address="0xM")], readings={(HB, 20261015): reading(final=True)})
        self.assertEqual(result["resolve"], ["0xM"])

    def test_settled_markets_are_left_alone(self):
        result = run([market(resolved=True), market(cancelled=True, address="0xB")])
        self.assertEqual((result["publish"], result["resolve"], result["overdue"]), ([], [], []))


class TestAlerts(unittest.TestCase):
    def test_closed_over_12_hours_and_unsettled_is_overdue(self):
        self.assertEqual(len(run([market(close=NOW - 13 * HOUR)])["overdue"]), 1)
        self.assertEqual(run([market(close=NOW - 11 * HOUR)])["overdue"], [])

    def test_cancel_risk_without_a_reading(self):
        near = market(close=NOW - WEEK + 24 * HOUR)
        self.assertEqual(len(run([near])["cancelRisk"]), 1)
        self.assertIn("cancelRisk", run([near])["alerts"])

    def test_a_published_reading_removes_the_cancel_risk(self):
        # cancel() reverts once a reading exists for the day.
        open_to_cancel = market(close=NOW - WEEK - HOUR)
        result = run([open_to_cancel], readings={(HB, 20261015): reading()})
        self.assertEqual(result["cancelRisk"], [])

    def test_a_dst_changeover_day_is_unsettleable_and_never_fetched_for(self):
        close = int(datetime(2026, 10, 31, 17, 30, tzinfo=timezone.utc).timestamp())
        now = int(datetime(2026, 11, 1, 12, tzinfo=timezone.utc).timestamp())
        result = run([market(day=20261101, close=close)], files={}, now=now, last=20261110)
        self.assertEqual(len(result["unsettleable"]), 1)
        self.assertFalse(result["fetchNeeded"])  # 1 Nov never gets a file

    def test_a_file_that_differs_from_the_chain_is_drift(self):
        drift = run([market()], files={(HB, 20261015): file(source_hash="bb" * 32)},
                    readings={(HB, 20261015): reading()})
        self.assertEqual(len(drift["fileDrift"]), 1)
        same = run([market()], files={(HB, 20261015): file(source_hash="0x" + "AA" * 32)},
                   readings={(HB, 20261015): reading()})
        self.assertEqual(same["fileDrift"], [])

    def test_an_absurd_value_is_held(self):
        result = run([market()], readings={(HB, 20261015): reading(value=150_000)})
        self.assertEqual(result["outOfRange"], [{"metricId": HB, "dayKey": 20261015, "value": 150_000}])
        self.assertEqual(run([market()], readings={(HB, 20261015): reading(value=-5_000)})["outOfRange"], [])

    def test_the_ladder_must_reach_beyond_tomorrow(self):
        self.assertTrue(run(last=20261016)["ladderRunningOut"])
        self.assertFalse(run(last=20261017)["ladderRunningOut"])
        self.assertTrue(run(last=None)["ladderRunningOut"])

    def test_low_gas(self):
        result = run(balances={"reporter": 10**15, "settler": 10**17})
        self.assertEqual(result["lowGas"], ["reporter"])

    def test_a_quiet_day_has_no_alerts(self):
        self.assertEqual(run([market(close=NOW + HOUR)])["alerts"], [])


class TestOutput(unittest.TestCase):
    def test_field_text_for_the_shell(self):
        self.assertEqual(sd.field_text(True), "true")
        self.assertEqual(sd.field_text(None), "")
        self.assertEqual(sd.field_text(0), "0")
        self.assertEqual(sd.field_text([{"dayKey": 20261014}, {"dayKey": 20261015}]),
                         "20261014 20261015")

    def test_render_names_every_alert(self):
        text = sd.render(run([market(close=NOW - 13 * HOUR)], files={}))
        self.assertIn("ALERTS:", text)
        self.assertIn("not settled", text)

    def test_dst_days(self):
        from datetime import date
        self.assertTrue(sd.is_dst_changeover(date(2026, 11, 1)))
        self.assertTrue(sd.is_dst_changeover(date(2026, 3, 8)))
        self.assertFalse(sd.is_dst_changeover(date(2026, 10, 15)))


class TestVerifiedMarketsOnly(unittest.TestCase):
    """S6: a ledger row is planned only when shared/addresses.json lists it
    with the same terms, a pinned factory lists it, and the contract agrees."""

    from web3 import Web3 as _W3
    ADDR = _W3.to_checksum_address("0x" + "a1" * 20)
    ORACLE = "0x970cefFC0e75bCa245F3337715992ad520A4D561"
    HASHES = {_W3.keccak(text=HB).hex().removeprefix("0x"): HB}
    ROW = {"market": ADDR, "metricId": HB, "dayKey": 20261015, "threshold": 4000,
           "resolveAfter": CLOSE_15, "disputeWindow": WEEK}

    def chain(self, **overrides):
        values = {"oracle": self.ORACLE, "metricId": next(iter(self.HASHES)), "dayKey": 20261015,
                  "threshold": 4000, "resolveAfter": CLOSE_15, "disputeWindow": WEEK}
        values.update(overrides)
        return values

    def check(self, row=None, listed=None, factory=None, chain="default"):
        row = row or self.ROW
        listed = {self.ADDR: dict(self.ROW)} if listed is None else listed
        factory = {self.ADDR} if factory is None else factory
        chain = self.chain() if chain == "default" else chain
        return sd.verify_market(row, listed, factory, chain, self.ORACLE, self.HASHES)

    def test_a_listed_verified_market_passes(self):
        self.assertIsNone(self.check())
        self.assertIsNone(self.check(chain=None))   # settled: not read further

    def test_a_ledger_injected_address_is_not_planned(self):
        evil = dict(self.ROW, market="0x" + "66" * 20)
        self.assertEqual(self.check(row=evil), "not in shared/addresses.json")

    def test_terms_that_differ_from_addresses_are_not_planned(self):
        self.assertIn("threshold differs", self.check(row=dict(self.ROW, threshold=1)))

    def test_a_market_not_from_a_pinned_factory_is_not_planned(self):
        self.assertIn("pinned MarketFactory", self.check(factory=set()))

    def test_a_market_on_another_oracle_is_not_planned(self):
        self.assertIn("oracle()", self.check(chain=self.chain(oracle="0x" + "66" * 20)))

    def test_chain_terms_that_differ_are_not_planned(self):
        for field, value in (("dayKey", 1), ("threshold", 1), ("resolveAfter", 1), ("disputeWindow", 1),
                             ("metricId", "00" * 32)):
            with self.subTest(field=field):
                self.assertIsNotNone(self.check(chain=self.chain(**{field: value})))

    def test_unverified_markets_are_an_alert(self):
        result = sd.plan([], {}, {}, NOW, WINDOW, 20261020, None,
                         [{"market": "0x" + "66" * 20, "dayKey": 20261015, "reason": "x"}])
        self.assertIn("unverifiedMarkets", result["alerts"])


class TestCommittedInputsOnly(unittest.TestCase):
    """S7: the plan reads git show HEAD:..., and refuses a dirty input."""

    def setUp(self):
        import shutil
        import subprocess
        import tempfile
        self.repo = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.repo, True)
        (self.repo / "data" / "metrics").mkdir(parents=True)
        self.path = self.repo / "data" / "metrics" / f"{HB}__2026-10-15.json"
        self.path.write_text('{"value": 3120, "sourceHash": "aa"}')
        for cmd in (["git", "init", "-q"], ["git", "add", "-A"],
                    ["git", "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "x"]):
            subprocess.run(cmd, cwd=self.repo, check=True, capture_output=True)
        from unittest.mock import patch
        patcher = patch.object(sd, "ROOT", self.repo)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_files_come_from_head_not_the_working_tree(self):
        self.path.write_text('{"value": 999999, "sourceHash": "bb"}')
        self.assertEqual(sd.load_files({(HB, 20261015)})[(HB, 20261015)]["value"], 3120)

    def test_a_dirty_input_refuses_to_plan(self):
        self.path.write_text('{"value": 999999}')
        with self.assertRaisesRegex(sd.PublisherError, "uncommitted changes"):
            sd.refuse_dirty_inputs()

    def test_an_untracked_metric_file_refuses_to_plan(self):
        (self.repo / "data" / "metrics" / f"{HB}__2026-10-16.json").write_text("{}")
        with self.assertRaisesRegex(sd.PublisherError, "uncommitted changes"):
            sd.refuse_dirty_inputs()

    def test_a_clean_tree_plans(self):
        sd.refuse_dirty_inputs()


if __name__ == "__main__":
    unittest.main()
