"""daily_settle.sh: the order of steps, the holds, the stop words, and what it
commits. Each test runs the real script in a throwaway git repo with a bare
remote. Python is a stub: settle_due.py hands back a sequence of fixture
plans, the chain scripts record their arguments, and plan_field's inline
reader runs on the real interpreter. No network, no keys, no chain.
"""

import net_guard  # noqa: F401  (tests never reach the network)
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "daily_settle.sh"
sys.path.insert(0, str(ROOT / "scripts"))

import extend_ladder  # noqa: E402

BRANCH = "feat/live"

FAKE_PYTHON = """\
#!/usr/bin/env bash
echo "python $*" >> "$STUB_LOG"
case "$1" in
  -) exec "$REAL_PYTHON" "$@" ;;
  scripts/settle_due.py)
    out=""
    for ((i = 1; i <= $#; i++)); do
      if [[ "${!i}" == "--json" ]]; then j=$((i + 1)); out="${!j}"; fi
    done
    n=$(( $(cat "$STUB_DIR/count" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$STUB_DIR/count"
    plan="$STUB_DIR/plan$n.json"
    [[ -f "$plan" ]] || plan="$STUB_DIR/last.json"
    cp "$plan" "$out"
    if [[ "$*" == *--check* ]]; then exit "${STUB_CHECK_EXIT:-0}"; fi
    ;;
  publish.py)
    [[ -n "${STUB_PUBLISH_OUT:-}" ]] && echo "$STUB_PUBLISH_OUT"
    if [[ "$*" == *--live* ]]; then
      cat /dev/fd/3 > "$STUB_DIR/password-seen" 2>/dev/null || true
      if [[ -n "${STUB_LEDGER_JSON:-}" ]]; then
        echo "$STUB_LEDGER_JSON" > data/publish-ledger.json
      else
        echo "{\\"run\\": \\"$RANDOM$RANDOM\\"}" > data/publish-ledger.json
      fi
    fi
    [[ -n "${STUB_HOLD_AFTER_PUBLISH:-}" ]] && touch "$STUB_HOLD_AFTER_PUBLISH"
    exit "${STUB_PUBLISH_EXIT:-0}"
    ;;
  scripts/extend_ladder.py) printf "%s" "${STUB_LADDER_ROWS:-}" ;;
  create_markets.py)
    # Records one market in the ledger, as the real script does per market.
    [[ "$*" == *--live* ]] && echo '{"made": 1}' > data/market-ledger.json
    exit "${STUB_CREATE_EXIT:-0}"
    ;;
esac
exit 0
"""

FAKE_SECRET = """\
#!/usr/bin/env bash
echo "secret $1" >> "$STUB_LOG"
printf 'stub-password-for-%s' "$1"
"""

EMPTY_PLAN = {"fetchNeeded": False, "publishStart": None, "publishEnd": None,
              "secondsToFinalizable": None, "finalizeStart": None, "outOfRange": [],
              "resolve": [], "ladderRunningOut": False, "alerts": [], "oracleRotatable": True}


def run(cmd, cwd, env=None, check=True):
    return subprocess.run(cmd, cwd=cwd, env=env, check=check, text=True, capture_output=True)


class DailySettleScriptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.remote = self.tmp / "remote.git"
        self.repo = self.tmp / "repo"
        self.stub = self.tmp / "stub"
        self.stub.mkdir()
        self.log = self.tmp / "stub.log"
        self.log.touch()
        run(["git", "init", "--quiet", "--bare", str(self.remote)], cwd=self.tmp)
        run(["git", "init", "--quiet", "-b", "main", str(self.repo)], cwd=self.tmp)
        self.git("config", "user.email", "test@example.com")
        self.git("config", "user.name", "Test")
        shutil.copy(SCRIPT, self.repo / "daily_settle.sh")
        for path, text in {"data/publish-ledger.json": "{}\n", "README.md": "repo\n",
                           ".gitignore": "logs/\n.settle.lock/\n"}.items():
            (self.repo / path).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / path).write_text(text)
        self.git("add", "-A")
        self.git("commit", "--quiet", "-m", "initial")
        self.git("remote", "add", "origin", str(self.remote))
        self.git("push", "--quiet", "origin", "main")
        self.git("checkout", "--quiet", "-b", BRANCH)
        self.git("push", "--quiet", "origin", BRANCH)
        self.python = self.write_exe("python", FAKE_PYTHON)
        self.secret = self.write_exe("secret", FAKE_SECRET)
        self.hold = self.tmp / "hold"

    def write_exe(self, name, text):
        path = self.tmp / name
        path.write_text(text)
        path.chmod(path.stat().st_mode | stat.S_IEXEC)
        return path

    def git(self, *args):
        return run(["git", *args], cwd=self.repo).stdout.strip()

    def plans(self, *plans):
        """settle_due.py returns these in order, then the last one forever."""
        for i, plan in enumerate(plans, 1):
            (self.stub / f"plan{i}.json").write_text(json.dumps({**EMPTY_PLAN, **plan}))
        (self.stub / "last.json").write_text(json.dumps({**EMPTY_PLAN, **plans[-1]}))

    def settle(self, *args, **env_extra):
        env = {**os.environ, "PYTHON_BIN": str(self.python), "REAL_PYTHON": sys.executable,
               "STUB_LOG": str(self.log), "STUB_DIR": str(self.stub),
               "SETTLE_BRANCH": BRANCH, "SETTLE_HOLD_FILE": str(self.hold),
               "SETTLE_SECRET_CMD": str(self.secret), "SETTLE_RETRY_SECONDS": "0",
               "SETTLE_MAX_WAIT_SECONDS": "1", "REPORTER_KEYSTORE_PATH": "/stub/reporter.json",
               "SETTLER_KEYSTORE_PATH": "/stub/settler.json"}
        for key in ("HC_PING_URL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "SETTLE_HOLD", "SETTLE_DRY_RUN",
                    "GITHUB_OUTPUT"):
            env.pop(key, None)
        env.update(env_extra)
        result = run(["bash", "daily_settle.sh", *args], cwd=self.repo, env=env, check=False)
        return result.returncode, result.stdout + result.stderr, self.log.read_text()

    def calls(self, log, script):
        return [line for line in log.splitlines() if line.startswith(f"python {script}")]

    def test_refuses_main(self):
        self.git("checkout", "--quiet", "main")
        self.plans({})
        code, out, _ = self.settle("--dry-run")
        self.assertEqual(code, 1)
        self.assertIn("refusing to run on main", out)

    def test_a_hold_stops_before_anything(self):
        self.plans({"publishStart": 20261014, "publishEnd": 20261014})
        code, out, log = self.settle(SETTLE_HOLD="1")
        self.assertEqual(code, 0)
        self.assertIn("Hold is set", out)
        self.assertEqual(log, "")

    def test_a_quiet_day_does_nothing_and_passes(self):
        self.plans({})
        code, out, log = self.settle("--no-deploy")
        self.assertEqual(code, 0, out)
        self.assertIn("finished with no alerts", out)
        self.assertEqual(self.calls(log, "publish.py"), [])

    def test_a_dry_run_sends_and_commits_nothing(self):
        self.plans({"publishStart": 20261014, "publishEnd": 20261020},
                   {"finalizeStart": 20261014, "resolve": ["0xM"]})
        head = self.git("rev-parse", "HEAD")
        code, out, log = self.settle("--dry-run")
        self.assertEqual(code, 0, out)
        for script in ("publish.py", "finalize.py", "resolve_markets.py"):
            self.assertTrue(self.calls(log, script), script)
            self.assertNotIn("--live", " ".join(self.calls(log, script)))
        self.assertNotIn("secret", log)
        self.assertEqual(self.git("rev-parse", "HEAD"), head)

    def test_publish_gets_the_password_through_a_pipe_and_commits_the_ledger_alone(self):
        self.plans({"publishStart": 20261014, "publishEnd": 20261020}, {})
        (self.repo / "README.md").write_text("someone's unrelated edit\n")
        self.git("add", "README.md")
        code, out, log = self.settle("--live", "--chain", "--no-deploy")
        self.assertEqual(code, 0, out)
        publish = " ".join(self.calls(log, "publish.py"))
        for flag in ("--live", "--yes", "--metric ERCOT_HBNORTH_DA_AVG", "--start 20261014",
                     "--end 20261020", "--limit 7"):
            self.assertIn(flag, publish)
        self.assertEqual((self.stub / "password-seen").read_text(), "stub-password-for-reporter-password")
        self.assertNotIn("stub-password", out)
        self.assertEqual(self.git("show", "--name-only", "--format=", "HEAD"), "data/publish-ledger.json")
        self.assertEqual(self.git("rev-parse", "HEAD"),
                         run(["git", "rev-parse", BRANCH], cwd=self.remote).stdout.strip())

    def test_a_stop_word_stops_before_finalizing(self):
        self.plans({"publishStart": 20261014, "publishEnd": 20261014, "finalizeStart": 20261014})
        code, out, log = self.settle("--live", "--chain", "--no-deploy",
                                     STUB_PUBLISH_OUT="CORRECTION ERCOT_HBNORTH_DA_AVG:20261014")
        self.assertEqual(code, 1)
        self.assertIn("stop word", out)
        self.assertEqual(self.calls(log, "finalize.py"), [])
        self.assertEqual(len(self.calls(log, "publish.py")), 1)  # never retried

    def test_a_failure_without_a_stop_word_is_retried_once(self):
        self.plans({"publishStart": 20261014, "publishEnd": 20261014})
        code, out, log = self.settle("--live", "--chain", "--no-deploy", STUB_PUBLISH_EXIT="1")
        self.assertEqual(code, 1)
        self.assertEqual(len(self.calls(log, "publish.py")), 2)
        self.assertIn("failed twice", out)

    def test_a_hold_set_during_the_dispute_window_stops_before_finalizing(self):
        self.plans({"publishStart": 20261014, "publishEnd": 20261014},
                   {"secondsToFinalizable": 1}, {"finalizeStart": 20261014})
        code, out, log = self.settle("--live", "--chain", "--no-deploy", STUB_HOLD_AFTER_PUBLISH=str(self.hold))
        self.assertEqual(code, 0, out)
        self.assertIn("stopped before finalizing", out)
        self.assertEqual(self.calls(log, "finalize.py"), [])

    def test_an_out_of_range_value_holds_finalizing(self):
        self.plans({"finalizeStart": 20261014,
                    "outOfRange": [{"metricId": "ERCOT_HBNORTH_DA_AVG", "dayKey": 20261014, "value": 150000}]})
        code, out, log = self.settle("--live", "--chain", "--no-deploy")
        self.assertEqual(code, 1)
        self.assertIn("finalizing held", out)
        self.assertEqual(self.calls(log, "finalize.py"), [])

    def test_alerts_after_the_run_fail_it(self):
        self.plans({"alerts": ["overdue"]})
        code, out, _ = self.settle("--live", "--chain", "--no-deploy", STUB_CHECK_EXIT="3")
        self.assertEqual(code, 1)
        self.assertIn("alerts after the run", out)

    def test_an_empty_ladder_is_extended_and_created(self):
        self.plans({"ladderRunningOut": True}, {})
        (self.repo / "shared").mkdir()
        for name in ("demo-markets.md", "addresses.json"):
            (self.repo / "shared" / name).write_text("x\n")
        (self.repo / "data" / "market-ledger.json").write_text("{}\n")
        self.git("add", "-A")
        self.git("commit", "--quiet", "-m", "files")
        self.git("push", "--quiet", "origin", BRANCH)
        (self.repo / "shared" / "demo-markets.md").write_text("x\nrows 60-62\n")
        code, out, log = self.settle("--live", "--chain", "--no-deploy", STUB_LADDER_ROWS="60\n61\n62\n")
        self.assertEqual(code, 0, out)
        create = " ".join(self.calls(log, "create_markets.py"))
        self.assertIn("--market 60 --market 61 --market 62 --live --yes", create)
        self.assertIn("next week's ladder", self.git("log", "-1", "--format=%s"))

    def ladder_files(self):
        (self.repo / "shared").mkdir()
        for name in ("demo-markets.md", "addresses.json"):
            (self.repo / "shared" / name).write_text("x\n")
        (self.repo / "data" / "market-ledger.json").write_text("{}\n")
        self.git("add", "-A")
        self.git("commit", "--quiet", "-m", "files")
        self.git("push", "--quiet", "origin", BRANCH)

    def test_a_failed_create_is_never_retried_and_keeps_what_was_made(self):
        self.plans({"ladderRunningOut": True}, {})
        self.ladder_files()
        code, out, log = self.settle("--live", "--chain", "--no-deploy",
                                     STUB_LADDER_ROWS="60\n61\n", STUB_CREATE_EXIT="1")
        self.assertEqual(code, 1)
        self.assertEqual(len(self.calls(log, "create_markets.py")), 1)
        self.assertIn("not retried", out)
        # The market it did make is committed and pushed, so the next run sees it.
        self.assertEqual(self.git("show", "--name-only", "--format=", "HEAD"), "data/market-ledger.json")
        self.assertEqual(self.git("rev-parse", "HEAD"),
                         run(["git", "rev-parse", BRANCH], cwd=self.remote).stdout.strip())

    # ------------------------------------------------------------ nothing live by default

    def test_no_flags_is_a_dry_run(self):
        self.plans({"publishStart": 20261014, "publishEnd": 20261014, "ladderRunningOut": True},
                   {"finalizeStart": 20261014, "resolve": ["0xM"]})
        head = self.git("rev-parse", "HEAD")
        code, out, log = self.settle(SETTLE_DRY_RUN="0")
        self.assertEqual(code, 0, out)
        self.assertIn("DRY RUN", out)
        self.assertNotIn("--live", log)
        self.assertNotIn("secret", log)
        self.assertEqual(self.calls(log, "create_markets.py"), [])
        self.assertEqual(self.git("rev-parse", "HEAD"), head)

    def test_live_without_chain_sends_nothing_and_reads_no_secret(self):
        self.plans({"publishStart": 20261014, "publishEnd": 20261014, "ladderRunningOut": True},
                   {"finalizeStart": 20261014, "resolve": ["0xM"]})
        code, out, log = self.settle("--live", "--no-deploy", STUB_LADDER_ROWS="60\n")
        self.assertEqual(code, 0, out)
        for script in ("publish.py", "finalize.py", "resolve_markets.py"):
            self.assertNotIn("--live", " ".join(self.calls(log, script)), script)
        self.assertEqual(self.calls(log, "create_markets.py"), [])
        self.assertNotIn("secret", log)

    def test_with_the_chain_off_due_work_is_reported_not_failed(self):
        self.plans({"publishStart": 20261014, "publishEnd": 20261020, "alerts": ["overdue"]})
        code, out, _ = self.settle("--live", "--no-deploy", STUB_CHECK_EXIT="3")
        self.assertEqual(code, 0, out)
        self.assertIn("due on chain, with the chain steps off: publish 20261014-20261020", out)
        self.assertIn("./daily_settle.sh --live --chain", out)

    def test_dry_run_flag_wins_over_live(self):
        self.plans({"publishStart": 20261014, "publishEnd": 20261014})
        code, out, log = self.settle("--live", "--chain", "--dry-run")
        self.assertEqual(code, 0, out)
        self.assertNotIn("--live", " ".join(self.calls(log, "publish.py")))
        self.assertNotIn("secret", log)

    def test_sends_nothing_to_an_oracle_whose_reporter_cannot_be_replaced(self):
        self.plans({"publishStart": 20261014, "publishEnd": 20261014, "oracleRotatable": False})
        code, out, log = self.settle("--live", "--chain", "--no-deploy")
        self.assertEqual(code, 1)
        self.assertIn("not a GridOracleV2", out)
        self.assertEqual(self.calls(log, "publish.py"), [])
        self.assertNotIn("secret", log)

    def test_the_first_oracle_is_fine_for_a_run_without_the_chain(self):
        self.plans({"oracleRotatable": False})
        code, out, _ = self.settle("--live", "--no-deploy")
        self.assertEqual(code, 0, out)

    def test_never_switches_branches_itself(self):
        self.git("checkout", "--quiet", "-b", "feat/other")
        self.plans({})
        code, out, _ = self.settle("--live", "--chain", "--no-deploy")
        self.assertEqual(code, 1)
        self.assertIn("check out feat/live first", out)
        self.assertEqual(self.git("symbolic-ref", "--short", "HEAD"), "feat/other")

    def test_publish_tells_telegram_the_values(self):
        ledger = json.dumps({"ERCOT_HBNORTH_DA_AVG:20261014": {
            "metricId": "ERCOT_HBNORTH_DA_AVG", "dayKey": 20261014, "value": 4123, "status": "published"}})
        self.plans({"publishStart": 20261014, "publishEnd": 20261014}, {"secondsToFinalizable": 0})
        code, out, _ = self.settle("--live", "--chain", "--no-deploy", STUB_LEDGER_JSON=ledger)
        self.assertEqual(code, 0, out)
        self.assertIn("Published 20261014-20261014: 20261014 $41.23/MWh", out)

    def test_a_push_is_reported_to_the_github_deploy_job(self):
        self.plans({"publishStart": 20261014, "publishEnd": 20261014}, {})
        output = self.tmp / "github-output"
        code, out, _ = self.settle("--live", "--chain", "--no-deploy", GITHUB_OUTPUT=str(output))
        self.assertEqual(code, 0, out)
        lines = output.read_text().splitlines()
        self.assertIn("changed=1", lines)
        self.assertIn(f"sha={self.git('rev-parse', 'HEAD')}", lines)


class TestExtendLadder(unittest.TestCase):
    ROWS = [
        "| 58 | `ERCOT_HBNORTH_DA_AVG` | > $40 | `20261020` | 2026-10-20 | live | x |",
        "| 59 | `ERCOT_HBNORTH_DA_AVG` | > $50 | `20261021` | 2026-10-21 | live | x |",
    ]
    # 19 Oct 2026 00:20 UTC.
    NOW = 1_792_369_200

    def test_adds_three_strikes_for_each_missing_day_numbered_from_the_bottom(self):
        rows = extend_ladder.new_rows(self.ROWS, self.NOW, (30, 40, 50))
        days = [r.split("|")[4].strip().strip("`") for r in rows]
        self.assertNotIn("20261020", days)   # already listed
        self.assertNotIn("20261021", days)
        self.assertEqual(rows[0].split("|")[1].strip(), "60")
        self.assertEqual({r.split("|")[3].strip() for r in rows}, {"> $30", "> $40", "> $50"})
        self.assertEqual(len(rows) % 3, 0)

    OTHER = ["| 1 | `X` | > $1 | `20250101` | 2025-01-01 | live | x |"]

    def test_never_adds_a_day_whose_close_is_too_near(self):
        # 19 Oct 17:00 UTC: 20 Oct's close (19 Oct 17:30 UTC) is 30 minutes away.
        rows = extend_ladder.new_rows(self.OTHER, 1_792_429_200, (30,))
        self.assertNotIn("20261020", " ".join(rows))
        self.assertIn("20261021", " ".join(rows))

    def test_skips_daylight_saving_days(self):
        # 31 Oct 00:20 UTC: the next week includes 1 Nov, which can't settle.
        rows = extend_ladder.new_rows(self.OTHER, 1_793_406_000, (30,))
        self.assertNotIn("20261101", " ".join(rows))
        self.assertIn("20261102", " ".join(rows))

    def test_strikes_follow_recent_prices(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        today = date(2026, 11, 6)
        for i in range(1, 8):
            day = today - timedelta(days=i)
            (tmp / f"ERCOT_HBNORTH_DA_AVG__{day.isoformat()}.json").write_text(json.dumps({"value": 2600}))
        with unittest.mock.patch.object(extend_ladder, "METRICS_DIR", tmp), \
                unittest.mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SETTLE_LADDER_STRIKES", None)
            self.assertEqual(extend_ladder.recent_strikes(today), (15, 25, 35))
        with unittest.mock.patch.dict(os.environ, {"SETTLE_LADDER_STRIKES": "30,40,50"}):
            self.assertEqual(extend_ladder.recent_strikes(today), (30, 40, 50))


if __name__ == "__main__":
    unittest.main()
