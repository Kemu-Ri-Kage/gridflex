"""The workflows, read as text (no YAML library in the lockfile), plus the
mode-decision step executed in bash exactly as written in the workflow.

S1: no pull or fetch in the run; checks use $GITHUB_SHA, never origin/main;
    the deploy job builds exactly needs.settle.outputs.sha.
S2: a pull-request CI with no secrets; CODEOWNERS covers the code.
S9: no artifact upload. S11: variables compared in bash, exactly.
S12: a live dispatch needs an operator. S13: pnpm comes from package.json.
"""

import net_guard  # noqa: F401  (tests never reach the network)

import json
import os
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SETTLE = (ROOT / ".github" / "workflows" / "daily-settle.yml").read_text()
CI = (ROOT / ".github" / "workflows" / "ci.yml").read_text()


def code_lines(path):
    """A shell script's lines without comments."""
    return [line for line in path.read_text().splitlines() if not line.lstrip().startswith("#")]


def job(text, name):
    """The text of one job in a workflow."""
    match = re.search(rf"^  {name}:\n(.*?)(?=^  [a-z][a-z-]*:\n|\Z)", text, re.S | re.M)
    assert match, name
    return match.group(1)


def step_script(text, step_name):
    """The `run: |` block of the named step, dedented."""
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == f"- name: {step_name}")
    run_at = next(i for i in range(start, len(lines)) if lines[i].strip() == "run: |")
    indent = len(lines[run_at]) - len(lines[run_at].lstrip()) + 2
    body = []
    for line in lines[run_at + 1:]:
        if line.strip() and len(line) - len(line.lstrip()) < indent:
            break
        body.append(line)
    return textwrap.dedent("\n".join(body)) + "\n"


class TestSettleWorkflow(unittest.TestCase):
    def test_the_run_never_pulls_or_fetches(self):
        for script in ("daily_settle.sh", "ops/settle-preflight.sh"):
            text = "\n".join(code_lines(ROOT / script))
            with self.subTest(script=script):
                self.assertNotRegex(text, r"\bgit (pull|fetch)\b")

    def test_checks_use_the_reviewed_sha_never_a_moving_ref(self):
        workflow_code = "\n".join(l for l in SETTLE.splitlines() if not l.lstrip().startswith("#"))
        self.assertNotIn("origin/main", workflow_code)
        self.assertIn('git show "$GITHUB_SHA:ops/settle-preflight.sh" | bash -s -- settle "$GITHUB_SHA"', SETTLE)
        self.assertIn('git show "$GITHUB_SHA:ops/settle-preflight.sh" | bash -s -- check "$GITHUB_SHA"', SETTLE)

    def test_python_packages_come_from_mains_lockfile(self):
        self.assertEqual(SETTLE.count('git show "$GITHUB_SHA:requirements.lock"'), 2)

    def test_the_preflight_runs_before_the_settle_step_and_any_key(self):
        settle = job(SETTLE, "settle")
        preflight = settle.index("Bind the run to the reviewed commit")
        self.assertLess(preflight, settle.index("- name: Write keystores"))
        self.assertLess(preflight, settle.index("- name: Settle"))
        self.assertLess(preflight, settle.index("actions/cache@"))

    def test_the_deploy_job_builds_exactly_the_pushed_commit_and_pushes_nothing(self):
        deploy = job(SETTLE, "deploy")
        self.assertIn("ref: ${{ needs.settle.outputs.sha }}", deploy)
        self.assertIn("persist-credentials: false", deploy)
        self.assertRegex(deploy, r"permissions:\n\s+contents: read")
        self.assertIn("./refresh_data.sh --no-fetch --no-commit", deploy)
        self.assertNotIn("feat/judging-sprint\n          fetch-depth", deploy)

    def test_no_artifact_and_no_log_tail_leaves_the_run(self):
        self.assertNotIn("upload-artifact", SETTLE)
        self.assertNotIn("tail -n", "\n".join(code_lines(ROOT / "daily_settle.sh")))

    def test_the_variables_are_compared_in_bash_not_in_expressions(self):
        self.assertNotRegex(SETTLE, r"vars\.SETTLE_(LIVE|CHAIN)\s*==")
        self.assertNotIn("vars.SETTLE_HOLD", SETTLE)

    def test_keys_are_written_only_for_a_chain_run(self):
        self.assertRegex(SETTLE, r"- name: Write keystores\n\s+if: env.CHAIN == '1'")
        self.assertIn("REPORTER_KEYSTORE_PASSWORD: ${{ env.CHAIN == '1' && secrets", SETTLE)
        self.assertIn("SETTLER_KEYSTORE_PASSWORD: ${{ env.CHAIN == '1' && secrets", SETTLE)

    def test_every_action_is_pinned_to_a_commit(self):
        for text in (SETTLE, CI):
            for ref in re.findall(r"uses: (\S+)", text):
                with self.subTest(ref=ref):
                    self.assertRegex(ref, r"@[0-9a-f]{40}$")

    def test_pnpm_comes_from_package_json(self):
        deploy = job(SETTLE, "deploy")
        self.assertIn("package_json_file: web/package.json", deploy)
        self.assertNotRegex(deploy, r"pnpm/action-setup@\S+\s*#[^\n]*\n\s+with:\n\s+version:")
        import importlib.util
        spec = importlib.util.spec_from_file_location("check_pnpm_pin", ROOT / "scripts" / "check_pnpm_pin.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertRegex(module.check(), r"^pnpm@\d+\.\d+\.\d+$")


class TestModeDecision(unittest.TestCase):
    """The workflow's own 'Decide dry or live' script, run in bash (S11, S12)."""

    SCRIPT = step_script(SETTLE, "Decide dry or live (exact comparisons, in bash)")

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.repo = self.tmp / "repo"
        (self.repo / "shared").mkdir(parents=True)
        pins = json.loads((ROOT / "shared" / "pins.json").read_text())
        (self.repo / "shared" / "pins.json").write_text(json.dumps(pins))
        for cmd in (["git", "init", "-q"], ["git", "add", "-A"],
                    ["git", "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "pins"]):
            subprocess.run(cmd, cwd=self.repo, check=True, capture_output=True)
        self.sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.repo, check=True,
                                  capture_output=True, text=True).stdout.strip()

    def decide(self, want="1", event="schedule", actor="someone", live="", chain="", operators=""):
        env_file = self.tmp / "github_env"
        env_file.write_text("")
        env = {"PATH": os.environ["PATH"], "WANT_LIVE": want, "EVENT": event, "ACTOR": actor,
               "SETTLE_LIVE_VAR": live, "SETTLE_CHAIN_VAR": chain, "SETTLE_OPERATORS_VAR": operators,
               "GITHUB_ENV": str(env_file), "GITHUB_SHA": self.sha}
        result = subprocess.run(["bash", "-e", "-c", self.SCRIPT], cwd=self.repo, env=env,
                                capture_output=True, text=True)
        mode = dict(line.split("=", 1) for line in env_file.read_text().splitlines())
        return result.returncode, mode, result.stdout + result.stderr

    def test_only_exactly_yes_is_live(self):
        self.assertEqual(self.decide(live="yes")[1], {"LIVE": "1", "CHAIN": "0"})
        for spelling in ("YES", "Yes", "yes ", " yes", "y", "true", "1", ""):
            with self.subTest(spelling=spelling):
                self.assertEqual(self.decide(live=spelling)[1], {"LIVE": "0", "CHAIN": "0"})

    def test_chain_needs_exactly_yes_too(self):
        for spelling in ("YES", "Yes", "yes "):
            with self.subTest(spelling=spelling):
                self.assertEqual(self.decide(live="yes", chain=spelling)[1]["CHAIN"], "0")

    def test_chain_is_refused_while_no_oracle_v2_is_pinned(self):
        code, mode, out = self.decide(live="yes", chain="yes")
        self.assertEqual(code, 1)
        self.assertIn("pins no GridOracleV2", out)
        self.assertEqual(mode, {})

    def test_a_dispatch_without_the_live_input_is_dry(self):
        self.assertEqual(self.decide(want="0", event="workflow_dispatch", live="yes")[1]["LIVE"], "0")

    def test_a_live_dispatch_by_a_non_operator_is_dry(self):
        code, mode, out = self.decide(event="workflow_dispatch", actor="mallory", live="yes",
                                      operators="Kemu-Ri-Kage,teslenkoplaton")
        self.assertEqual((code, mode["LIVE"]), (0, "0"))
        self.assertIn("not in SETTLE_OPERATORS", out)
        # Unset operators: nobody may dispatch live.
        self.assertEqual(self.decide(event="workflow_dispatch", actor="mallory", live="yes")[1]["LIVE"], "0")

    def test_a_live_dispatch_by_an_operator_is_live(self):
        self.assertEqual(self.decide(event="workflow_dispatch", actor="teslenkoplaton", live="yes",
                                     operators="Kemu-Ri-Kage,teslenkoplaton")[1]["LIVE"], "1")

    def test_an_operator_prefix_is_not_an_operator(self):
        self.assertEqual(self.decide(event="workflow_dispatch", actor="Kemu", live="yes",
                                     operators="Kemu-Ri-Kage")[1]["LIVE"], "0")

    def test_scheduled_runs_need_no_operator(self):
        self.assertEqual(self.decide(event="schedule", live="yes")[1]["LIVE"], "1")


class TestCiAndOwners(unittest.TestCase):
    def test_ci_runs_on_pull_requests_with_no_secrets(self):
        self.assertIn("pull_request:", CI)
        self.assertRegex(CI, r"permissions:\n\s+contents: read")
        self.assertNotIn("secrets.", CI)
        self.assertNotIn("environment:", CI)
        self.assertIn("  tests:", CI)
        for command in ("python -m unittest discover -s tests", "shellcheck", "actionlint",
                        "scripts/check_pnpm_pin.py"):
            self.assertIn(command, CI)

    def test_codeowners_owns_everything_but_the_job_data(self):
        owners = (ROOT / ".github" / "CODEOWNERS").read_text()
        self.assertRegex(owners, r"(?m)^\*\s+@\S+")
        self.assertRegex(owners, r"(?m)^/shared/addresses\.json\s+@\S+")
        for line in owners.splitlines():
            if line.startswith("/") and not re.search(r"\s@\S+", line):
                self.assertRegex(line, r"^/(data/|web/public/data/|web/lib/generated/)", line)


if __name__ == "__main__":
    unittest.main()
