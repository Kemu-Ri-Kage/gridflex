"""Stage 0 changes (Revision 2 plan): the resolver walks superseded
factories, the market ledger keeps a predecessor's record when a newer
factory re-creates the same market, ledger saves are atomic, and the
read-only state report compares files with the chain.

Chain access is faked at the scripts' own seams, as the other suites do.
"""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from web3 import Web3

import create_markets
import resolve_markets as rm
from publish import PublisherError

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import state_report  # noqa: E402

CURRENT = Web3.to_checksum_address("0x" + "aa" * 20)
OLD = Web3.to_checksum_address("0x" + "bb" * 20)
ORACLE = Web3.to_checksum_address("0x" + "11" * 20)
HBNORTH = Web3.keccak(text="ERCOT_HBNORTH_DA_AVG").hex().removeprefix("0x")


class TestLoadAddressesLegacyFactories(unittest.TestCase):
    def load(self, config):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "addresses.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            with patch.object(create_markets, "ADDRESSES_PATH", path):
                return create_markets.load_addresses()

    def base(self, **extra):
        return dict({"chainId": 1952, "GridOracle": ORACLE, "MarketFactory": CURRENT,
                     "MockUSDT": "0x" + "33" * 20}, **extra)

    def test_without_legacy_section_the_list_is_empty(self):
        self.assertEqual(self.load(self.base())["legacyFactories"], [])

    def test_legacy_factories_are_checksummed(self):
        config = self.base(legacyDeployments={"MarketFactory": [
            {"address": OLD.lower(), "status": "superseded", "transaction": "0x79"}]})
        self.assertEqual(self.load(config)["legacyFactories"], [OLD])

    def test_malformed_legacy_entry_is_refused(self):
        config = self.base(legacyDeployments={"MarketFactory": [{"status": "superseded"}]})
        with self.assertRaisesRegex(PublisherError, "legacyDeployments"):
            self.load(config)


class TestResolverWalksLegacyFactories(unittest.TestCase):
    def test_markets_of_the_old_factory_are_listed_and_tagged(self):
        w3 = MagicMock()
        current_market = Web3.to_checksum_address("0x" + "01" * 20)
        old_market = Web3.to_checksum_address("0x" + "02" * 20)

        def contract(address, abi):
            c = MagicMock()
            if address == CURRENT:
                c.functions.getMarkets.return_value.call.return_value = [current_market]
            elif address == OLD:
                c.functions.getMarkets.return_value.call.return_value = [old_market]
            return c

        w3.eth.contract.side_effect = contract
        read = MagicMock(side_effect=lambda w3_, oracle, address, abi, block, legacy=None:
                         rm.MarketState(address=address, metric_hash=HBNORTH, day_key=20260926,
                                        threshold=4500, resolve_after=1, resolved=False,
                                        cancelled=False, yes_won=False, reading_value=None,
                                        reading_final=False, legacy_factory=legacy))
        addresses = {"oracle": ORACLE, "factory": CURRENT, "legacyFactories": [OLD]}
        with patch.object(rm, "read_market", read), patch.object(rm, "load_abi", return_value=[]), \
                patch.object(rm.time, "sleep"):
            states = rm.list_market_states(w3, addresses, 100)
        self.assertEqual([s.address for s in states], [current_market, old_market])
        self.assertIsNone(states[0].legacy_factory)
        self.assertEqual(states[1].legacy_factory, OLD)
        text = "\n".join(rm.describe(states[1], rm.STATUS_NOT_PUBLISHED))
        self.assertIn(f"superseded factory {OLD}", text)
        text = "\n".join(rm.describe(states[0], rm.STATUS_NOT_PUBLISHED))
        self.assertNotIn("superseded", text)

    def test_addresses_without_legacy_list_still_work(self):
        w3 = MagicMock()
        w3.eth.contract.return_value.functions.getMarkets.return_value.call.return_value = []
        with patch.object(rm, "load_abi", return_value=[]):
            self.assertEqual(rm.list_market_states(w3, {"oracle": ORACLE, "factory": CURRENT}, 1), [])


class TestMarketLedgerKeepsPredecessors(unittest.TestCase):
    def load(self, ledger, current=CURRENT):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "market-ledger.json"
            path.write_text(json.dumps(ledger), encoding="utf-8")
            with patch.object(create_markets, "MARKET_LEDGER_PATH", path):
                return create_markets.load_market_ledger(current_factory=current)

    def test_entries_without_a_factory_are_left_untouched_under_the_logical_key(self):
        entry = {"threshold": 4500, "market": "0xabc"}
        loaded = self.load({"ERCOT_HBNORTH_DA_AVG:20260926:4500": entry})
        self.assertEqual(loaded, {"ERCOT_HBNORTH_DA_AVG:20260926:4500": entry})

    def test_current_factory_record_stays_under_the_logical_key(self):
        entry = {"threshold": 4500, "market": "0xabc", "factory": CURRENT.lower()}
        loaded = self.load({"ERCOT_HBNORTH_DA_AVG:20260926:4500": entry})
        self.assertEqual(loaded, {"ERCOT_HBNORTH_DA_AVG:20260926:4500": entry})

    def test_old_factory_record_moves_aside_and_is_preserved(self):
        old_entry = {"threshold": 4500, "market": "0xold", "factory": OLD}
        loaded = self.load({"ERCOT_HBNORTH_DA_AVG:20260926:4500": old_entry})
        legacy_key = create_markets.legacy_ledger_key("ERCOT_HBNORTH_DA_AVG:20260926:4500", OLD)
        self.assertNotIn("ERCOT_HBNORTH_DA_AVG:20260926:4500", loaded)
        self.assertEqual(loaded[legacy_key], old_entry)
        # A re-created market under the same logical key does not touch it.
        loaded["ERCOT_HBNORTH_DA_AVG:20260926:4500"] = {"threshold": 4500, "market": "0xnew", "factory": CURRENT}
        self.assertEqual(loaded[legacy_key]["market"], "0xold")
        self.assertEqual(len(loaded), 2)

    def test_already_suffixed_legacy_keys_pass_through(self):
        legacy_key = create_markets.legacy_ledger_key("ERCOT_HBNORTH_DA_AVG:20260926:4500", OLD)
        entry = {"threshold": 4500, "market": "0xold", "factory": OLD}
        self.assertEqual(self.load({legacy_key: entry}), {legacy_key: entry})

    def test_without_a_known_current_factory_nothing_is_migrated(self):
        entry = {"threshold": 4500, "market": "0xold", "factory": OLD}
        with patch.object(create_markets, "current_factory_address", return_value=None):
            loaded = self.load({"ERCOT_HBNORTH_DA_AVG:20260926:4500": entry}, current=None)
        self.assertEqual(loaded, {"ERCOT_HBNORTH_DA_AVG:20260926:4500": entry})

    def test_save_is_atomic_and_round_trips(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested" / "market-ledger.json"
            with patch.object(create_markets, "MARKET_LEDGER_PATH", path):
                create_markets.save_market_ledger({"k": {"market": "0x1"}})
                self.assertFalse(path.with_suffix(".json.tmp").exists())
                self.assertEqual(json.loads(path.read_text()), {"k": {"market": "0x1"}})
                self.assertTrue(path.read_text().endswith("\n"))


class TestWriteAddressesFileByMarketAddress(unittest.TestCase):
    def test_same_terms_from_a_new_factory_are_appended_not_dropped(self):
        old = {"metricId": "ERCOT_HBNORTH_DA_AVG", "dayKey": 20260926, "threshold": 4500,
               "market": "0xold", "yesToken": "0x1", "noToken": "0x2"}
        new = dict(old, market="0xnew", factory=CURRENT)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "addresses.json"
            path.write_text(json.dumps({"markets": [old]}), encoding="utf-8")
            with patch.object(create_markets, "ADDRESSES_PATH", path):
                create_markets.write_addresses_file([new, dict(old)])
            markets = json.loads(path.read_text(encoding="utf-8"))["markets"]
        self.assertEqual([m["market"] for m in markets], ["0xold", "0xnew"])


class TestStateReportComparison(unittest.TestCase):
    def report(self):
        return state_report.Report(block_number=1, chain_time=1_700_000_000, rpc_url="rpc")

    def test_matching_record_raises_nothing(self):
        report = self.report()
        record = {"metricId": "ERCOT_HBNORTH_DA_AVG", "dayKey": 20260926, "threshold": 4500,
                  "resolveAfter": 10, "disputeWindow": 604800}
        chain = {"metric": "ERCOT_HBNORTH_DA_AVG", "dayKey": 20260926, "threshold": 4500,
                 "resolveAfter": 10, "disputeWindow": 604800}
        state_report._compare_record(report, "0xm", "file", record, chain)
        self.assertEqual(report.discrepancies, [])

    def test_differing_threshold_is_flagged(self):
        report = self.report()
        record = {"metricId": "ERCOT_HBNORTH_DA_AVG", "dayKey": 20260926, "threshold": 4000}
        chain = {"metric": "ERCOT_HBNORTH_DA_AVG", "dayKey": 20260926, "threshold": 4500,
                 "resolveAfter": 10, "disputeWindow": 0}
        state_report._compare_record(report, "0xm", "file", record, chain)
        self.assertEqual(len(report.discrepancies), 1)
        self.assertIn("threshold", report.discrepancies[0].what)

    def test_legacy_factories_are_read_from_config(self):
        config = {"legacyDeployments": {"MarketFactory": [{"address": OLD.lower(), "transaction": "0x79"}]}}
        legacy = state_report.legacy_factories(config)
        self.assertEqual(legacy[0]["address"], OLD)
        self.assertEqual(legacy[0]["status"], "superseded")
        self.assertEqual(state_report.legacy_factories({}), [])

    def test_render_marks_cancellable_markets_and_verdict(self):
        report = self.report()
        report.factories = [{"address": CURRENT, "status": "current", "marketCount": 1, "transaction": None}]
        report.markets = [{
            "factory": CURRENT, "factoryStatus": "current", "address": "0x" + "01" * 20,
            "metric": "ERCOT_HBNORTH_DA_AVG", "dayKey": 20260926, "threshold": 4500,
            "resolveAfter": report.chain_time - 10, "disputeWindow": 5,
            "cancellableAt": report.chain_time - 5, "status": rm.STATUS_NOT_PUBLISHED,
            "resolved": False, "cancelled": False, "yesWon": False, "readingValue": None,
            "readingFinal": False, "inAddressesJson": True, "inMarketLedger": True,
        }]
        report.readings = {"ERCOT_HBNORTH_DA_AVG:20260926": None}
        from datetime import datetime, timezone
        text = state_report.render(report, datetime(2026, 10, 5, tzinfo=timezone.utc))
        self.assertIn("No discrepancies", text)
        self.assertIn("OPEN NOW", text)
        self.assertIn("of which **1** can be cancelled", text)
        report.markets[0]["readingValue"] = 3175
        text = state_report.render(report, datetime(2026, 10, 5, tzinfo=timezone.utc))
        self.assertIn("blocked by reading", text)
        self.assertNotIn("OPEN NOW", text)
        report.markets[0]["readingValue"] = None
        report.flag("x", "y")
        text = state_report.render(report, datetime(2026, 10, 5, tzinfo=timezone.utc))
        self.assertIn("1 discrepancy(ies)", text)

    def test_main_exit_code_follows_discrepancies(self):
        report = self.report()
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(state_report, "load_json", return_value={}), \
                patch.object(state_report, "load_addresses", return_value={}), \
                patch.object(state_report, "load_market_ledger", return_value={}), \
                patch.object(state_report, "load_ledger", return_value={}), \
                patch.object(state_report, "make_web3", return_value=MagicMock()), \
                patch.object(state_report, "collect", return_value=report):
            out = Path(directory) / "r.md"
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(state_report.main(["--out", str(out), "--quiet"]), 0)
            report.flag("a", "b")
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(state_report.main(["--out", str(out), "--quiet"]), 1)
            self.assertIn("`a`: b", out.read_text())


if __name__ == "__main__":
    unittest.main()
