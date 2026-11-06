"""scripts/switch_oracle.py: when the oracle may be retired, and what the
switch writes to shared/addresses.json. The chain is faked at the script's
own seams (read_new_oracle, current_oracle_markets, make_web3)."""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import switch_oracle as so  # noqa: E402
from publish import PublisherError  # noqa: E402

OLD = "0x970cefFC0e75bCa245F3337715992ad520A4D561"
NEW = "0x" + "AB" * 20
ROLES = {"owner": "0x" + "01" * 20, "reporter": "0x" + "02" * 20, "guardian": "0x" + "03" * 20,
         "paused": False, "disputeWindow": 3600}
CONFIG = {"chainId": 1952, "GridOracle": OLD, "MarketFactory": "0x" + "22" * 20,
          "MockUSDT": "0x" + "33" * 20, "reporter": "0x27Aad02480f1DC01ebCb53fd7321a4629BCbe902",
          "transactions": {"GridOracle": "0xolddeploy"},
          "legacyDeployments": {"MarketFactory": [{"address": "0x" + "44" * 20, "status": "superseded"}]}}


def market(day, resolved=True, cancelled=False):
    return {"market": f"0x{day}", "metricId": "ERCOT_HBNORTH_DA_AVG", "dayKey": day,
            "resolved": resolved, "cancelled": cancelled}


class TestUnsettled(unittest.TestCase):
    def test_settled_markets_and_final_readings_pass(self):
        rows = [{"metricId": "ERCOT_HBNORTH_DA_AVG", "dayKey": 20261020, "status": "finalized"}]
        self.assertEqual(so.unsettled([market(20261020), market(20261019, False, True)], rows), [])

    def test_an_open_market_or_unfinal_reading_blocks_the_switch(self):
        rows = [{"metricId": "ERCOT_HBNORTH_DA_AVG", "dayKey": 20261020, "status": "published"}]
        problems = so.unsettled([market(20261018, resolved=False)], rows)
        self.assertEqual(len(problems), 2)
        self.assertIn("20261018) is neither resolved nor cancelled", problems[0])
        self.assertIn("20261020 is 'published'", problems[1])


class TestSwitchedConfig(unittest.TestCase):
    def test_retires_the_old_oracle_with_its_last_day(self):
        updated = so.switched_config(CONFIG, NEW, "0xnewdeploy", ROLES, 20261020)
        self.assertEqual(updated["GridOracle"], so.Web3.to_checksum_address(NEW))
        self.assertEqual(updated["transactions"]["GridOracle"], "0xnewdeploy")
        self.assertEqual(updated["legacyDeployments"]["GridOracle"], [
            {"address": OLD, "lastDayKey": 20261020, "status": "retired", "transaction": "0xolddeploy"}])
        self.assertEqual(updated["legacyDeployments"]["MarketFactory"], CONFIG["legacyDeployments"]["MarketFactory"])
        self.assertEqual(updated["reporter"], ROLES["reporter"])
        self.assertEqual(updated["guardian"], ROLES["guardian"])
        self.assertEqual(updated["oracleOwner"], ROLES["owner"])
        self.assertEqual(CONFIG["GridOracle"], OLD, "the input is not modified")

    def test_refuses_the_oracle_already_in_use(self):
        with self.assertRaises(PublisherError):
            so.switched_config(CONFIG, OLD.lower(), "0x", ROLES, 20261020)


class TestMain(unittest.TestCase):
    def run_main(self, markets, ledger_rows, write, roles=ROLES):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            addresses = root / "addresses.json"
            addresses.write_text(json.dumps(CONFIG))
            ledger = root / "publish-ledger.json"
            ledger.write_text(json.dumps({f"k{i}": r for i, r in enumerate(ledger_rows)}))
            w3 = MagicMock()
            w3.eth.contract.return_value.functions.disputeWindow.return_value.call.return_value = 3600
            out = io.StringIO()
            with patch.object(so, "ADDRESSES_PATH", addresses), \
                    patch.object(so, "PUBLISH_LEDGER", ledger), \
                    patch.object(so, "load_addresses", return_value={"oracle": OLD}), \
                    patch.object(so, "make_web3", return_value=w3), \
                    patch.object(so, "read_new_oracle", return_value=roles), \
                    patch.object(so, "current_oracle_markets", return_value=markets), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                argv = ["--oracle", NEW, "--deploy-tx", "0xnewdeploy"] + (["--write"] if write else [])
                code = so.main(argv)
            return code, json.loads(addresses.read_text()), out.getvalue()

    def test_dry_run_changes_nothing(self):
        rows = [{"metricId": "ERCOT_HBNORTH_DA_AVG", "dayKey": 20261020, "status": "finalized"}]
        code, written, out = self.run_main([market(20261020)], rows, write=False)
        self.assertEqual(code, 0)
        self.assertEqual(written["GridOracle"], OLD)
        self.assertIn("DRY RUN", out)

    def test_write_switches_and_records_the_last_day(self):
        rows = [{"metricId": "ERCOT_LOAD_WEIGHTED_DA_INDEX", "dayKey": 20261012, "status": "finalized"}]
        code, written, _ = self.run_main([market(20261020), market(20261014)], rows, write=True)
        self.assertEqual(code, 0)
        self.assertEqual(written["GridOracle"], so.Web3.to_checksum_address(NEW))
        self.assertEqual(written["legacyDeployments"]["GridOracle"][0]["lastDayKey"], 20261020)

    def test_refuses_while_a_market_is_open(self):
        code, written, out = self.run_main([market(20261018, resolved=False)], [], write=True)
        self.assertEqual(code, 1)
        self.assertEqual(written["GridOracle"], OLD)
        self.assertIn("Not switching", out)

    def test_refuses_a_different_dispute_window(self):
        code, written, out = self.run_main([market(20261020)], [], write=True,
                                           roles={**ROLES, "disputeWindow": 7200})
        self.assertEqual(code, 1)
        self.assertIn("ORACLE_DISPUTE_WINDOW=3600", out)


if __name__ == "__main__":
    unittest.main()
