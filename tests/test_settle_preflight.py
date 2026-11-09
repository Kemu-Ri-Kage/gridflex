"""The settle run is bound to one reviewed main commit (audit finding S1) and
fails closed (S5-S9). Every test runs the real daily_settle.sh and main's
real ops/settle-preflight.sh in a throwaway repo with a bare remote, the way
the workflow does; Python, curl and the secrets are stubs (test_daily_settle).

S1 reproduction: the preflight passes, then someone pushes unreviewed code
to the unprotected data branch, then the run starts. At 6042707 step 1 did
`git pull` and ran that code; here it must never run.
"""

import net_guard  # noqa: F401  (tests never reach the network)

import json
import re
import subprocess
from pathlib import Path

from test_daily_settle import BRANCH, SettleHarness, day_plan, run

ROOT = Path(__file__).resolve().parent.parent


class TestBindingToReviewedCode(SettleHarness):
    """S1."""

    def evil_refresh(self, marker):
        return f"#!/usr/bin/env bash\ntouch {marker}\necho UNREVIEWED CODE RUNS\n"

    def test_push_after_check_is_never_executed(self):
        marker = self.tmp / "UNREVIEWED-CODE-RAN"
        self.plans({"fetchNeeded": True})
        env = self.env()
        bound, out = self.preflight(env)
        self.assertIsNotNone(bound, out)
        checked = bound["SETTLE_CHECKED_HEAD"]
        # The race: an unreviewed code commit lands after the check.
        evil = self.push_from_elsewhere("refresh_data.sh", self.evil_refresh(marker))
        self.assertEqual(self.remote_head(), evil)
        result = run(["bash", "daily_settle.sh", "--live", "--no-deploy"], cwd=self.repo,
                     env={**env, **bound}, check=False)
        out = result.stdout + result.stderr
        self.assertFalse(marker.exists(), "unreviewed code ran:\n" + out)
        self.assertNotIn("UNREVIEWED CODE RUNS", out)
        self.assertEqual(self.git("rev-parse", "HEAD"), checked)
        self.assertNotIn(evil, self.git("rev-list", "HEAD"))
        # The reviewed refresh_data.sh is the one that ran.
        self.assertIn("refresh --requests-lifted --no-build --no-push", self.log.read_text())

    def test_the_next_preflight_refuses_the_unreviewed_commit(self):
        self.push_from_elsewhere("refresh_data.sh", "#!/usr/bin/env bash\necho evil\n")
        self.git("pull", "--quiet", "--ff-only", "origin", BRANCH)
        bound, out = self.preflight(self.env())
        self.assertIsNone(bound)
        self.assertIn("refresh_data.sh (not a data file)", out)

    def test_head_moved_after_check_refuses(self):
        self.plans(day_plan(20261014))
        code, out, log = self.settle("--live", "--chain", "--no-deploy", before_run=lambda: (
            (self.repo / "data" / "metrics").mkdir(parents=True, exist_ok=True),
            (self.repo / "data" / "metrics" / "x.json").write_text("{}\n"),
            self.git("add", "-A"), self.git("commit", "--quiet", "-m", "moved")))
        self.assertEqual(code, 1)
        self.assertIn("is not the commit the preflight checked", out)
        self.assertEqual(self.calls(log, "scripts/settle_due.py"), [])   # nothing ran, not even the plan

    def test_code_edited_in_the_working_tree_after_check_refuses(self):
        self.plans(day_plan(20261014))
        code, out, log = self.settle("--live", "--chain", "--no-deploy",
                                     before_run=lambda: (self.repo / "refresh_data.sh").write_text("echo evil\n"))
        self.assertEqual(code, 1)
        self.assertIn("files outside the data paths changed", out)
        self.assertEqual(self.calls(log, "publish.py"), [])

    def test_code_changed_by_a_step_stops_before_the_next_one(self):
        self.plans(day_plan(20261014), {"finalizeStart": 20261014,
                                        "finalize": [{"metricId": "ERCOT_HBNORTH_DA_AVG", "dayKey": 20261014}]})
        code, out, log = self.settle("--live", "--chain", "--no-deploy",
                                     STUB_PUBLISH_TAMPER=str(self.repo / "README.md"))
        self.assertEqual(code, 1)
        self.assertIn("files outside the data paths changed", out)
        self.assertEqual(self.calls(log, "finalize.py"), [])

    def test_editing_the_running_script_changes_nothing(self):
        # Bash parses the whole of main() first, so a step that appends to
        # daily_settle.sh can't inject commands into the running run.
        marker = self.tmp / "INJECTED"
        self.plans(day_plan(20261014), {})
        code, out, _ = self.settle("--live", "--chain", "--no-deploy",
                                   STUB_PUBLISH_TAMPER=str(self.repo / "daily_settle.sh"),
                                   STUB_TAMPER_TEXT=f"touch {marker}")
        self.assertFalse(marker.exists())
        self.assertEqual(code, 1)
        self.assertIn("files outside the data paths changed", out)

    def test_live_without_code_sha_refuses(self):
        self.plans(day_plan(20261014))
        for args in (("--live",), ("--live", "--chain")):
            with self.subTest(args=args):
                code, out, log = self.settle(*args, "--no-deploy", bind=False)
                self.assertEqual(code, 1)
                self.assertIn("needs SETTLE_CODE_SHA", out)
                self.assertEqual(self.calls(log, "scripts/settle_due.py"), [])

    def test_a_dry_run_needs_no_binding(self):
        self.plans({})
        code, out, _ = self.settle("--dry-run", bind=False)
        self.assertEqual(code, 0, out)

    def test_rejected_push_fails_without_pull(self):
        self.plans(day_plan(20261014), {})
        theirs = None

        def someone_pushes():
            nonlocal theirs
            theirs = self.push_from_elsewhere("data/metrics/ERCOT_HBNORTH_DA_AVG__2026-10-30.json", "{}\n",
                                              "their data")
        code, out, _ = self.settle("--live", "--chain", "--no-deploy", before_run=someone_pushes)
        self.assertEqual(code, 1)
        self.assertIn("push rejected", out)
        self.assertIn("nothing was pulled", out)
        self.assertEqual(self.remote_head(), theirs)
        self.assertNotIn(theirs, self.git("rev-list", "HEAD"))

    def test_preflight_merges_the_exact_reviewed_commit_not_moving_main(self):
        reviewed = self.main_sha
        self.git("checkout", "--quiet", "main")
        (self.repo / "later.txt").write_text("not reviewed yet\n")
        self.git("add", "-A")
        self.git("commit", "--quiet", "-m", "later main commit")
        later = self.git("rev-parse", "HEAD")
        self.git("checkout", "--quiet", BRANCH)
        bound, out = self.preflight(self.env(), sha=reviewed)
        self.assertIsNotNone(bound, out)
        self.assertEqual(bound["SETTLE_CODE_SHA"], reviewed)
        self.assertNotIn(later, self.git("rev-list", "HEAD"))

    def test_preflight_refuses_a_short_or_symbolic_ref(self):
        for sha in ("main", "origin/main", self.main_sha[:12]):
            with self.subTest(sha=sha):
                bound, out = self.preflight(self.env(), sha=sha)
                self.assertIsNone(bound)
                self.assertIn("full 40-hex SHA", out)

    def test_preflight_refuses_when_verify_data_refuses(self):
        bound, out = self.preflight(self.env(STUB_VERIFY_EXIT="1"))
        self.assertIsNone(bound)
        self.assertIn("verify_data refused", out)

    def test_preflight_refuses_a_dirty_checkout(self):
        (self.repo / "untracked.py").write_text("import os\n")
        bound, out = self.preflight(self.env())
        self.assertIsNone(bound)
        self.assertIn("not clean", out)

    def test_check_mode_refuses_a_commit_without_the_reviewed_code(self):
        bound, out = self.preflight(self.env(), mode="check", sha="f" * 40)
        self.assertIsNone(bound)


class TestHold(SettleHarness):
    """S5: the hold is a remote ref, read fresh at every decision point."""

    def test_a_hold_ref_at_the_start_stops_everything(self):
        self.git("push", "--quiet", "origin", "HEAD:refs/heads/settle-hold")
        self.plans(day_plan(20261014))
        code, out, log = self.settle("--live", "--chain", "--no-deploy")
        self.assertEqual(code, 0)
        self.assertIn("hold ref refs/heads/settle-hold exists", out)
        self.assertEqual(self.calls(log, "scripts/settle_due.py"), [])

    def test_a_hold_ref_created_during_the_wait_stops_before_finalizing(self):
        self.plans(day_plan(20261014), {"secondsToFinalizable": 1},
                   {"finalizeStart": 20261014, "finalize": [{"metricId": "ERCOT_HBNORTH_DA_AVG", "dayKey": 20261014}]})
        code, out, log = self.settle("--live", "--chain", "--no-deploy", STUB_PUBLISH_HOLD_REF="1")
        self.assertEqual(code, 0, out)
        self.assertIn("stopped before finalizing", out)
        self.assertEqual(self.calls(log, "finalize.py"), [])

    def test_an_unreadable_hold_ref_before_a_chain_step_stops(self):
        self.plans(day_plan(20261014), {"secondsToFinalizable": 1},
                   {"finalizeStart": 20261014, "finalize": [{"metricId": "ERCOT_HBNORTH_DA_AVG", "dayKey": 20261014}]})
        # The remote vanishes after the publish was pushed (plan #2 is read then).
        code, out, log = self.settle("--live", "--chain", "--no-deploy", STUB_BREAK_REMOTE_AT="2")
        self.assertEqual(code, 0, out)
        self.assertIn("could not be read", out)
        self.assertEqual(self.calls(log, "finalize.py"), [])

    def test_the_publish_notice_names_a_hold_that_works(self):
        self.plans(day_plan(20261014), {"secondsToFinalizable": 0})
        code, out, _ = self.settle("--live", "--chain", "--no-deploy")
        self.assertEqual(code, 0, out)
        self.assertIn("refs/heads/settle-hold", out)
        self.assertNotIn("gh variable set SETTLE_HOLD", out)

    def test_the_vars_snapshot_hold_is_only_a_start_hold(self):
        self.plans(day_plan(20261014))
        code, out, log = self.settle("--live", "--chain", "--no-deploy", SETTLE_HOLD="1")
        self.assertEqual(code, 0)
        self.assertIn("nothing done", out)
        self.assertEqual(self.calls(log, "scripts/settle_due.py"), [])


class TestScope(SettleHarness):
    """S6: every chain step gets exactly the planned targets."""

    A = "0x" + "a1" * 20
    B = "0x" + "b2" * 20

    def test_resolve_gets_exactly_the_planned_markets(self):
        self.plans({"resolve": [self.A, self.B]}, {})
        code, out, log = self.settle("--live", "--chain", "--no-deploy")
        self.assertEqual(code, 0, out)
        (call,) = self.calls(log, "resolve_markets.py")
        self.assertEqual(re.findall(r"--market (\S+)", call), [self.A, self.B])
        self.assertIn("--live --yes", call)

    def test_a_non_address_in_the_resolve_plan_fails(self):
        self.plans({"resolve": [self.A, "0xA; rm -rf ~"]})
        code, out, log = self.settle("--live", "--chain", "--no-deploy")
        self.assertEqual(code, 1)
        self.assertEqual(self.calls(log, "resolve_markets.py"), [])

    def test_finalize_gets_the_last_planned_day(self):
        days = [{"metricId": "ERCOT_HBNORTH_DA_AVG", "dayKey": d} for d in (20261014, 20261015, 20261016)]
        self.plans({"finalizeStart": 20261014, "finalize": days}, {})
        code, out, log = self.settle("--live", "--chain", "--no-deploy")
        self.assertEqual(code, 0, out)
        (call,) = self.calls(log, "finalize.py")
        self.assertIn("--start 20261014 --end 20261016 --limit 7", call)

    def test_publish_gets_each_planned_day(self):
        self.plans(day_plan(20261014, 20261016), {})
        code, out, log = self.settle("--live", "--chain", "--no-deploy")
        self.assertEqual(code, 0, out)
        (call,) = self.calls(log, "publish.py")
        self.assertEqual(re.findall(r"--day (\d+)", call), ["20261014", "20261016"])

    def test_unverified_markets_stop_a_chain_run(self):
        self.plans({**day_plan(20261014), "unverifiedMarkets": [
            {"market": self.A, "dayKey": 20261014, "reason": "not in shared/addresses.json"}]})
        code, out, log = self.settle("--live", "--chain", "--no-deploy")
        self.assertEqual(code, 1)
        self.assertIn("failed verification", out)
        self.assertEqual(self.calls(log, "publish.py"), [])

    def test_a_ladder_row_already_committed_is_never_created(self):
        self.plans({"ladderRunningOut": True}, {})
        (self.repo / "shared").mkdir()
        (self.repo / "shared" / "demo-markets.md").write_text("| 59 | `ERCOT_HBNORTH_DA_AVG` |\n")
        (self.repo / "shared" / "addresses.json").write_text("{}\n")
        (self.repo / "data" / "market-ledger.json").write_text("{}\n")
        self.git("add", "-A")
        self.git("commit", "--quiet", "-m", "files")
        code, out, log = self.settle("--live", "--chain", "--no-deploy", STUB_LADDER_ROWS="59\n")
        self.assertEqual(code, 1)
        self.assertIn("already in the committed table", out)
        self.assertEqual(self.calls(log, "create_markets.py"), [])


class TestDataBeforePush(SettleHarness):
    """S7, the run's side: a failed fetch leaves only committed data."""

    def test_a_failed_fetch_restores_the_tree_and_commits_nothing(self):
        refresh = ("#!/usr/bin/env bash\necho \"refresh $*\" >> \"$STUB_LOG\"\n"
                   "mkdir -p data/metrics\necho '{\"value\": 999999}' > data/metrics/ERCOT_HBNORTH_DA_AVG__2026-11-08.json\n"
                   "echo '{\"half\": true}' > data/publish-ledger.json\nexit 1\n")
        self.git("checkout", "--quiet", "main")
        (self.repo / "refresh_data.sh").write_text(refresh)
        self.git("commit", "--quiet", "-am", "refresh that fails half-way")
        self.main_sha = self.git("rev-parse", "HEAD")
        self.git("checkout", "--quiet", BRANCH)
        self.plans({"fetchNeeded": True}, {})
        before = self.remote_head()
        code, out, log = self.settle("--live", "--no-deploy")
        self.assertEqual(code, 0, out)
        self.assertIn("nothing fetched was committed", out)
        self.assertFalse((self.repo / "data/metrics/ERCOT_HBNORTH_DA_AVG__2026-11-08.json").exists())
        self.assertEqual((self.repo / "data/publish-ledger.json").read_text(), "{}\n")
        self.assertEqual(self.remote_head(), before)
        # The plan after the failure is read again, from the committed files.
        self.assertGreaterEqual(len(self.calls(log, "scripts/settle_due.py")), 2)


class TestFailures(SettleHarness):
    """S8: errors propagate, stop words are always seen, the plan fails closed."""

    ALERTS = {"TELEGRAM_BOT_TOKEN": "123456:telegram-token-not-real-0000000000000", "TELEGRAM_CHAT_ID": "42",
              "HC_PING_URL": "https://hc-ping.com/00000000-0000-0000-0000-000000000000"}

    def test_a_failing_commit_inside_commit_paths_alerts(self):
        hook = Path(self.git("rev-parse", "--git-path", "hooks/pre-commit"))
        hook = hook if hook.is_absolute() else self.repo / hook
        hook.parent.mkdir(parents=True, exist_ok=True)
        hook.write_text("#!/bin/sh\nexit 1\n")
        hook.chmod(0o755)
        self.plans(day_plan(20261014), {})
        code, out, _ = self.settle("--live", "--chain", "--no-deploy", **self.ALERTS)
        self.assertEqual(code, 1)
        self.assertIn("git commit failed", out)
        alerts = self.curl_log.read_text()
        self.assertIn("api.telegram.org", alerts)
        self.assertIn("hc-ping.com", alerts)
        self.assertIn("/fail", alerts)

    def test_a_stop_word_as_the_very_last_bytes_is_seen(self):
        self.plans(day_plan(20261014), {"finalizeStart": 20261014,
                                        "finalize": [{"metricId": "ERCOT_HBNORTH_DA_AVG", "dayKey": 20261014}]})
        code, out, log = self.settle("--live", "--chain", "--no-deploy",
                                     STUB_PUBLISH_LAST_BYTES="ERCOT_HBNORTH_DA_AVG:20261014 still pending")
        self.assertEqual(code, 1)
        self.assertIn("stop word (still pending)", out)
        self.assertEqual(self.calls(log, "finalize.py"), [])

    def test_the_new_stop_words_stop(self):
        for word in ("reverted", "PROVENANCE", "not in the ledger", "ORACLE IDENTITY", "still pending"):
            with self.subTest(word=word):
                self.setUp()
                self.plans(day_plan(20261014))
                code, out, log = self.settle("--live", "--chain", "--no-deploy", STUB_PUBLISH_OUT=f"x {word} y")
                self.assertEqual(code, 1)
                self.assertEqual(len(self.calls(log, "publish.py")), 1)

    def test_an_unreadable_plan_fails(self):
        self.plans(day_plan(20261014))
        code, out, log = self.settle("--live", "--chain", "--no-deploy", STUB_BAD_PLAN="1")
        self.assertEqual(code, 1)
        self.assertIn("plan.json is unreadable", out)
        self.assertEqual(self.calls(log, "publish.py"), [])

    def test_a_plan_missing_a_field_fails(self):
        self.plans({})
        plan = json.loads((self.stub / "last.json").read_text())
        del plan["fetchNeeded"]
        (self.stub / "last.json").write_text(json.dumps(plan))
        (self.stub / "plan1.json").write_text(json.dumps(plan))
        code, out, _ = self.settle("--live", "--no-deploy")
        self.assertEqual(code, 1)
        self.assertIn("field fetchNeeded", out)


class TestNoLeaks(SettleHarness):
    """S9: canary secrets never reach logs/, healthchecks or Telegram text."""

    CANARIES = {"GRIDSTATUS_API_KEY": "canary-gridstatus-key-1",
                "REPORTER_KEYSTORE_PASSWORD": "canary-reporter-password-2",
                "SETTLER_KEYSTORE_PASSWORD": "canary-settler-password-3",
                "TELEGRAM_BOT_TOKEN": "123456:canary-telegram-token-000000000000000",
                "TELEGRAM_CHAT_ID": "42",
                "HC_PING_URL": "https://hc-ping.com/canary-ping-0000-0000"}

    def test_canary_secrets_never_appear_in_logs_or_alerts(self):
        self.plans(day_plan(20261014), {"secondsToFinalizable": 0})
        # The publish step leaks its whole environment, and then fails.
        code, out, _ = self.settle("--live", "--chain", "--no-deploy", STUB_PUBLISH_LEAK="1",
                                   STUB_PUBLISH_EXIT="1", **self.CANARIES)
        self.assertEqual(code, 1)
        secrets = [v for k, v in self.CANARIES.items() if k != "TELEGRAM_CHAT_ID"]
        logs = "".join(p.read_text() for p in (self.repo / "logs").glob("*") if p.is_file())
        self.assertIn("[REDACTED]", logs)
        for secret in secrets:
            self.assertNotIn(secret, logs)
            self.assertNotIn(secret, out)
        alerts = self.curl_log.read_text()
        bodies = [line for line in alerts.splitlines() if line.startswith("body: ")]
        self.assertTrue(bodies)
        for body in bodies:
            self.assertRegex(body, r"^body: step=[0-9a-z ]+ exit=\d+$")
        texts = re.findall(r"text=GRIDFLEX\\ settle:([^ ]*(?:\\ [^ ]*)*)", alerts)
        self.assertTrue(texts)
        for text in texts:
            for secret in ("canary-gridstatus-key-1", "canary-reporter-password-2", "canary-settler-password-3"):
                self.assertNotIn(secret, text)

    def test_redact_catches_secrets_by_value_and_by_shape(self):
        text = ("key canary-gridstatus-key-1 then 987654:AAbbCCddEEffGGhhIIjjKKllMMnnOOpp12 "
                "and https://hc-ping.com/abcdefgh-1234/fail\n")
        result = subprocess.run(["bash", str(ROOT / "ops" / "redact.sh")], input=text, text=True,
                                capture_output=True, env={"GRIDSTATUS_API_KEY": "canary-gridstatus-key-1",
                                                          "PATH": "/usr/bin:/bin"})
        self.assertNotIn("canary-gridstatus-key-1", result.stdout)
        self.assertNotIn("AAbbCCdd", result.stdout)
        self.assertNotIn("abcdefgh-1234", result.stdout)
        self.assertEqual(result.stdout.count("[REDACTED]"), 3)
