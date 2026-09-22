"""refresh_data.sh: never on main, and the site only ever gets what is committed.

Each test runs the real script in a throwaway git repo with a bare remote.
Python and pnpm are stubs: the Python stub stands in for the fetch/build
steps by rewriting data files, the pnpm stub records what the working tree
and HEAD looked like at build and deploy time. No network, no GridStatus.
"""

import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "refresh_data.sh"
BRANCH = "feat/data"

FAKE_PYTHON = """\
#!/usr/bin/env bash
echo "python $*" >> "$STUB_LOG"
case "$1" in
  fetch_ercot.py) printf 'GridStatus requests this run: 1\nGridStatus rows fetched this run: 1,234\n' ;;
  build_candles.py) printf 'GridStatus requests this run: 2\nGridStatus rows fetched this run: 100\n' ;;
  build_feed_data.py)
    if [[ -z "${STUB_NO_CHANGE:-}" ]]; then
      echo "{\\"run\\": \\"$RANDOM$RANDOM\\"}" > web/public/data/price.json
      echo "{}" > data/metrics/ERCOT_HBNORTH_DA_AVG__2026-09-22.json
    fi
    ;;
esac
"""

FAKE_PNPM = """\
#!/usr/bin/env bash
cd "$STUB_REPO"
echo "pnpm $* head=$(git rev-parse HEAD) dirty=[$(git status --porcelain --untracked-files=all -- web data/metrics | tr '\\n' ' ')]" >> "$STUB_LOG"
"""


def run(cmd, cwd, env=None, check=True):
    return subprocess.run(cmd, cwd=cwd, env=env, check=check, text=True, capture_output=True)


class RefreshScriptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.remote = self.tmp / "remote.git"
        self.repo = self.tmp / "repo"
        self.log = self.tmp / "stub.log"
        self.log.touch()
        run(["git", "init", "--quiet", "--bare", str(self.remote)], cwd=self.tmp)
        run(["git", "init", "--quiet", "-b", "main", str(self.repo)], cwd=self.tmp)
        self.git("config", "user.email", "test@example.com")
        self.git("config", "user.name", "Test")

        shutil.copy(SCRIPT, self.repo / "refresh_data.sh")
        for path, text in {
            "web/app.tsx": "export {};\n",
            "web/public/data/price.json": "{}\n",
            "data/metrics/ERCOT_HBNORTH_DA_AVG__2026-09-21.json": "{}\n",
            "README.md": "repo\n",
        }.items():
            (self.repo / path).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / path).write_text(text)
        self.git("add", "-A")
        self.git("commit", "--quiet", "-m", "initial")
        self.git("remote", "add", "origin", str(self.remote))
        self.git("push", "--quiet", "origin", "main")
        self.git("checkout", "--quiet", "-b", BRANCH)
        self.git("push", "--quiet", "origin", BRANCH)

        bin_dir = self.tmp / "bin"
        bin_dir.mkdir()
        self.python = self.stub(bin_dir / "python", FAKE_PYTHON)
        self.pnpm = self.stub(bin_dir / "pnpm", FAKE_PNPM)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def stub(self, path, body):
        path.write_text(body)
        path.chmod(path.stat().st_mode | stat.S_IEXEC)
        return path

    def git(self, *args):
        return run(["git", *args], cwd=self.repo).stdout.strip()

    def refresh(self, *args, **env):
        full_env = {
            **os.environ,
            "GRIDSTATUS_API_KEY": "test-key",
            "PYTHON_BIN": str(self.python),
            "PNPM_BIN": str(self.pnpm),
            "STUB_LOG": str(self.log),
            "STUB_REPO": str(self.repo),
            **env,
        }
        return run(["bash", "refresh_data.sh", *args], cwd=self.repo, env=full_env, check=False)

    def calls(self):
        return self.log.read_text().splitlines()

    def remote_head(self):
        return run(["git", "rev-parse", BRANCH], cwd=self.remote).stdout.strip()

    def test_refuses_to_run_on_main(self):
        self.git("checkout", "--quiet", "main")
        result = self.refresh()
        self.assertEqual(result.returncode, 1)
        self.assertIn("Refusing to run on main", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_refuses_a_detached_head(self):
        self.git("checkout", "--quiet", "--detach")
        result = self.refresh()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.calls(), [])

    def test_commits_pushes_then_deploys_the_commit(self):
        before = self.git("rev-parse", "HEAD")
        result = self.refresh()
        self.assertEqual(result.returncode, 0, result.stderr)

        head = self.git("rev-parse", "HEAD")
        self.assertNotEqual(head, before)
        self.assertEqual(self.remote_head(), head)
        message = self.git("log", "-1", "--format=%B").strip()
        self.assertEqual(len(message.splitlines()), 1)
        self.assertTrue(message.startswith("Refresh market data, "))
        changed = self.git("diff", "--name-only", before, head).splitlines()
        self.assertEqual(
            sorted(changed),
            ["data/metrics/ERCOT_HBNORTH_DA_AVG__2026-09-22.json", "web/public/data/price.json"],
        )

        build, deploy = [c for c in self.calls() if c.startswith("pnpm")]
        self.assertIn("pnpm build", build)
        self.assertIn("pnpm exec wrangler deploy", deploy)
        for call in (build, deploy):
            self.assertIn(f"head={head}", call)
            self.assertIn("dirty=[]", call)
        self.assertIn("requests used by this refresh: 3", result.stdout)
        self.assertIn("rows used by this refresh: 1334", result.stdout)

    def test_fetch_fills_gaps_and_keeps_the_three_day_window(self):
        self.refresh()
        fetch = next(c for c in self.calls() if "fetch_ercot.py" in c)
        self.assertIn("--days 3", fetch)
        self.assertIn("--fill-gaps", fetch)

    def test_no_feed_only_data_is_fetched(self):
        self.refresh()
        steps = [c for c in self.calls() if c.startswith("python ")]
        self.assertEqual(steps, [
            "python fetch_ercot.py --days 3 --fill-gaps",
            "python build_candles.py",
            "python build_feed_data.py",
        ])

    def test_uncommitted_web_source_stops_it_before_fetching(self):
        (self.repo / "web/app.tsx").write_text("export const edited = 1;\n")
        result = self.refresh()
        self.assertEqual(result.returncode, 1)
        self.assertIn("web/app.tsx", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_an_untracked_web_file_stops_it_too(self):
        (self.repo / "web/scratch.tsx").write_text("x\n")
        self.assertEqual(self.refresh().returncode, 1)
        self.assertEqual(self.calls(), [])

    def test_stale_regenerated_data_is_not_a_reason_to_stop(self):
        # Leftover data from an earlier run is regenerated and committed.
        (self.repo / "web/public/data/price.json").write_text('{"old": true}\n')
        self.assertEqual(self.refresh().returncode, 0)

    def test_only_the_data_paths_are_committed(self):
        (self.repo / "README.md").write_text("staged, unrelated\n")
        self.git("add", "README.md")
        (self.repo / "notes.txt").write_text("untracked, unrelated\n")
        before = self.git("rev-parse", "HEAD")

        self.assertEqual(self.refresh().returncode, 0)

        changed = self.git("diff", "--name-only", before, "HEAD").splitlines()
        self.assertNotIn("README.md", changed)
        self.assertNotIn("notes.txt", changed)
        self.assertEqual(self.git("diff", "--cached", "--name-only"), "README.md")

    def test_nothing_changed_makes_no_commit_but_still_deploys(self):
        before = self.git("rev-parse", "HEAD")
        result = self.refresh(STUB_NO_CHANGE="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git("rev-parse", "HEAD"), before)
        self.assertIn("nothing to commit", result.stdout)
        self.assertTrue(any("wrangler deploy" in c for c in self.calls()))

    def test_a_failed_push_means_no_deploy(self):
        # Someone else pushed to the branch: the push is rejected.
        other = self.tmp / "other"
        run(["git", "clone", "--quiet", "-b", BRANCH, str(self.remote), str(other)], cwd=self.tmp)
        run(["git", "-c", "user.email=o@example.com", "-c", "user.name=O",
             "commit", "--quiet", "--allow-empty", "-m", "theirs"], cwd=other)
        run(["git", "push", "--quiet", "origin", BRANCH], cwd=other)

        result = self.refresh()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(c.startswith("pnpm") for c in self.calls()))

    def test_no_deploy_still_commits_and_pushes(self):
        result = self.refresh("--no-deploy")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.remote_head(), self.git("rev-parse", "HEAD"))
        self.assertFalse(any("wrangler" in c for c in self.calls()))
        self.assertIn("Deploy skipped", result.stdout)


if __name__ == "__main__":
    unittest.main()
