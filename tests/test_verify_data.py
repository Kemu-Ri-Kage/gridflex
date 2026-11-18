"""scripts/verify_data.py (audit finding S3): the data branch may only append
markets, each one checked against the reviewed pins and the chain. Each test
builds a throwaway repo whose main commit holds this checkout's own data
files and whose data commit appends the real 21 Nov 9-15 markets from
feat/judging-sprint ae4a092 (tests/fixtures), then tampers with one thing.
The chain is a fake that answers what the real markets hold."""

import net_guard  # noqa: F401  (tests never reach the network)

import copy
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from web3 import Web3

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import verify_data  # noqa: E402
from verify_data import Refused, Unreadable  # noqa: E402

import build_feed_data  # noqa: E402
import chain_guard  # noqa: E402

FIXTURE = json.loads((ROOT / "tests" / "fixtures" / "judging-sprint-ae4a092.json").read_text())
PINS = chain_guard.load_pins()
FILES = ("shared/addresses.json", "data/market-ledger.json", "shared/demo-markets.md",
         "web/public/data/addresses.json", "shared/pins.json")


def run(cmd, cwd):
    return subprocess.run(cmd, cwd=cwd, check=True, text=True, capture_output=True).stdout.strip()


class FakeChain:
    """Answers like the real chain for every fixture market, unless told otherwise."""

    def __init__(self, markets):
        self.chain = PINS.chain_id
        self.listed = {Web3.to_checksum_address(m["market"]) for m in markets}
        self.markets = {}
        for m in markets:
            self.markets[Web3.to_checksum_address(m["market"])] = {
                "oracle": PINS.oracle_v1, "collateral": PINS.collateral,
                "metricId": Web3.keccak(text=m["metricId"]).hex().removeprefix("0x"),
                **{f: m[f] for f in ("dayKey", "threshold", "resolveAfter", "disputeWindow",
                                     "yesToken", "noToken")}}
        self.readings = {}

    def chain_id(self):
        return self.chain

    def factory_markets(self, factory):
        assert factory == PINS.factory
        return set(self.listed)

    def market(self, address):
        return dict(self.markets[Web3.to_checksum_address(address)])

    def reading(self, metric_id, day_key):
        return self.readings.get((metric_id, day_key))


class VerifyDataTest(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.repo, True)
        run(["git", "init", "--quiet", "-b", "main"], self.repo)
        run(["git", "config", "user.email", "test@example.com"], self.repo)
        run(["git", "config", "user.name", "Test"], self.repo)
        for path in FILES:
            target = self.repo / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(ROOT / path, target)
        self.commit("main")
        self.base = run(["git", "rev-parse", "HEAD"], self.repo)
        run(["git", "checkout", "--quiet", "-b", "feat/data"], self.repo)
        self.chain = FakeChain(FIXTURE["markets"])
        self.append(FIXTURE["markets"], FIXTURE["ledger"], FIXTURE["demoRows"])

    # ---- helpers

    def read(self, path):
        return json.loads((self.repo / path).read_text())

    def write(self, path, data):
        text = data if isinstance(data, str) else json.dumps(data, indent=2) + "\n"
        (self.repo / path).write_text(text)

    def commit(self, message):
        run(["git", "add", "-A"], self.repo)
        run(["git", "commit", "--quiet", "--allow-empty", "-m", message], self.repo)

    def append(self, markets, ledger, rows):
        addresses = self.read("shared/addresses.json")
        addresses["markets"] += copy.deepcopy(markets)
        self.write("shared/addresses.json", addresses)
        self.write("data/market-ledger.json", {**self.read("data/market-ledger.json"), **copy.deepcopy(ledger)})
        lines = (self.repo / "shared/demo-markets.md").read_text().splitlines()
        last = max(i for i, line in enumerate(lines) if verify_data.ROW_RE.match(line))
        self.write("shared/demo-markets.md", "\n".join(lines[:last + 1] + rows + lines[last + 1:]) + "\n")
        self.commit("append")

    def verify(self):
        return verify_data.verify(self.repo, self.base, self.chain)

    def refused(self, pattern):
        with self.assertRaisesRegex(Refused, pattern):
            self.verify()

    # ---- a clean append passes

    def test_the_real_nov_9_15_append_passes(self):
        notes = self.verify()
        self.assertIn("21 appended market(s)", notes)

    def test_no_change_passes(self):
        run(["git", "reset", "--quiet", "--hard", self.base], self.repo)
        self.assertIn("0 appended market(s)", self.verify())

    # ---- addresses.json

    def test_changing_a_top_level_key_fails(self):
        head = run(["git", "rev-parse", "HEAD"], self.repo)
        for key, value in (("GridOracle", "0x" + "66" * 20), ("MockUSDT", "0x" + "66" * 20),
                           ("reporter", "0x" + "66" * 20), ("BinaryMarket", "0x" + "66" * 20)):
            with self.subTest(key=key):
                run(["git", "reset", "--quiet", "--hard", head], self.repo)
                addresses = self.read("shared/addresses.json")
                addresses[key] = value
                self.write("shared/addresses.json", addresses)
                self.commit("evil")
                with self.assertRaises((Refused, chain_guard.PinError)):
                    self.verify()

    def test_adding_a_top_level_key_fails(self):
        addresses = self.read("shared/addresses.json")
        addresses["GridOracleV3"] = "0x" + "66" * 20
        self.write("shared/addresses.json", addresses)
        self.commit("evil")
        self.refused("top-level keys changed")

    def test_editing_an_existing_market_fails(self):
        addresses = self.read("shared/addresses.json")
        addresses["markets"][3]["market"] = "0x" + "66" * 20
        self.write("shared/addresses.json", addresses)
        self.commit("evil")
        self.refused("existing market #4")

    def test_removing_an_existing_market_fails(self):
        addresses = self.read("shared/addresses.json")
        del addresses["markets"][0]
        self.write("shared/addresses.json", addresses)
        self.commit("evil")
        self.refused("edited, moved or replaced|removed")

    def test_reordering_existing_markets_fails(self):
        addresses = self.read("shared/addresses.json")
        markets = addresses["markets"]
        markets[0], markets[1] = markets[1], markets[0]
        self.write("shared/addresses.json", addresses)
        self.commit("evil")
        self.refused("existing market #1")

    # ---- appended markets on chain

    def test_an_appended_market_on_a_foreign_oracle_fails(self):
        self.chain.markets[Web3.to_checksum_address(FIXTURE["markets"][0]["market"])]["oracle"] = "0x" + "66" * 20
        self.refused("oracle\\(\\)")

    def test_an_appended_market_with_foreign_collateral_fails(self):
        self.chain.markets[Web3.to_checksum_address(FIXTURE["markets"][5]["market"])]["collateral"] = "0x" + "66" * 20
        self.refused("collateral\\(\\)")

    def test_an_appended_market_not_in_the_factory_fails(self):
        self.chain.listed.discard(Web3.to_checksum_address(FIXTURE["markets"][20]["market"]))
        self.refused("not listed by the pinned MarketFactory")

    def test_an_appended_market_whose_terms_differ_on_chain_fails(self):
        for field, value in (("threshold", 1), ("dayKey", 20261231), ("resolveAfter", 1),
                             ("disputeWindow", 0), ("metricId", "00" * 32),
                             ("yesToken", "0x" + "66" * 20)):
            with self.subTest(field=field):
                address = Web3.to_checksum_address(FIXTURE["markets"][2]["market"])
                original = self.chain.markets[address][field]
                self.chain.markets[address][field] = value
                with self.assertRaises(Refused):
                    self.verify()
                self.chain.markets[address][field] = original

    def test_a_wrong_chain_fails(self):
        self.chain.chain = 1
        self.refused("pinned chain")

    def test_a_chain_failure_is_unreadable_not_approved(self):
        def boom(_address):
            raise ConnectionError("rpc down")
        self.chain.market = boom
        with self.assertRaises(Unreadable):
            self.verify()

    # ---- the ledger

    def test_a_ledger_that_injects_a_market_fails(self):
        ledger = self.read("data/market-ledger.json")
        row = dict(next(iter(FIXTURE["ledger"].values())), market="0x" + "66" * 20, threshold=9900)
        ledger[f"{row['metricId']}:{row['dayKey']}:9900"] = row
        self.write("data/market-ledger.json", ledger)
        self.commit("evil")
        self.refused("not exactly the appended markets")

    def test_a_ledger_row_whose_terms_differ_fails(self):
        ledger = self.read("data/market-ledger.json")
        key = next(iter(FIXTURE["ledger"]))
        ledger[key]["resolveAfter"] += 1
        self.write("data/market-ledger.json", ledger)
        self.commit("evil")
        self.refused("resolveAfter differs")

    def test_an_edited_old_ledger_row_fails(self):
        ledger = self.read("data/market-ledger.json")
        key = next(k for k in ledger if k not in FIXTURE["ledger"])
        ledger[key]["market"] = "0x" + "66" * 20
        self.write("data/market-ledger.json", ledger)
        self.commit("evil")
        self.refused("was edited")

    # ---- demo-markets.md

    def test_an_edited_old_demo_row_fails(self):
        path = self.repo / "shared/demo-markets.md"
        path.write_text(path.read_text().replace("| 59 | `ERCOT_HBNORTH_DA_AVG` | > $50",
                                                 "| 59 | `ERCOT_HBNORTH_DA_AVG` | > $5"))
        self.commit("evil")
        self.refused("main's rows or text were changed")

    def test_an_appended_row_without_its_market_fails(self):
        path = self.repo / "shared/demo-markets.md"
        rows = FIXTURE["demoRows"]
        extra = rows[-1].replace("| 80 |", "| 81 |").replace("> $45", "> $55")
        path.write_text(path.read_text().replace(rows[-1], rows[-1] + "\n" + extra))
        self.commit("evil")
        self.refused("one to one")

    # ---- web/public/data/addresses.json

    def test_a_hand_edited_site_addresses_file_fails(self):
        site = self.read("web/public/data/addresses.json")
        site["MarketFactory"] = "0x" + "66" * 20
        self.write("web/public/data/addresses.json", site)
        self.commit("evil")
        self.refused("web/public/data/addresses.json")

    def test_the_regenerated_site_addresses_file_passes(self):
        out = self.repo / "web/public/data"
        from unittest.mock import patch
        with patch.object(build_feed_data, "ADDRESSES_SOURCE", self.repo / "shared/addresses.json"):
            build_feed_data.write_addresses(out)
        self.commit("regenerate")
        self.verify()

    # ---- metric files already on chain

    def test_a_changed_metric_file_must_match_the_chain(self):
        path = "data/metrics/ERCOT_HBNORTH_DA_AVG__2026-10-14.json"
        (self.repo / "data/metrics").mkdir(parents=True, exist_ok=True)
        self.write(path, {"value": 5635, "sourceHash": "ab" * 32})
        self.commit("metric")
        self.chain.readings[("ERCOT_HBNORTH_DA_AVG", 20261014)] = (5635, "ab" * 32)
        self.verify()
        self.chain.readings[("ERCOT_HBNORTH_DA_AVG", 20261014)] = (9999, "ab" * 32)
        self.refused("already on chain")

    # ---- fail closed

    def test_uncommitted_changes_fail(self):
        (self.repo / "shared/addresses.json").write_text("{}\n")
        self.refused("uncommitted")

    def test_pins_come_from_the_reviewed_base(self):
        # Even if the data commit changed the pins (code-matches-main refuses
        # that anyway), verification uses main's copy.
        pins = self.read("shared/pins.json")
        pins["oracleV1"] = "0x" + "66" * 20
        self.write("shared/pins.json", pins)
        addresses = self.read("shared/addresses.json")
        self.commit("evil pins")
        self.assertIn("21 appended market(s)", self.verify())
        self.assertEqual(addresses["GridOracle"], PINS.oracle_v1)


if __name__ == "__main__":
    unittest.main()
