#!/usr/bin/env bash
# Binds a settle run to one reviewed main commit (daily-settle spec §14,
# audit finding S1). The workflow runs main's copy, never the branch's:
#
#   git show "$GITHUB_SHA":ops/settle-preflight.sh | bash -s -- settle "$GITHUB_SHA"
#   git show "$GITHUB_SHA":ops/settle-preflight.sh | bash -s -- check "$GITHUB_SHA"
#
#   settle <sha>  on the checked-out data branch: merge <sha> (the exact
#                 commit, never the moving origin/main), then check
#   check <sha>   check only (the deploy job, on the exact pushed commit)
#
# The check: main's ops/code-matches-main.sh --allow-verified <sha>, then
# scripts/verify_data.py --base <sha> (which the code check has just proved
# is main's code). On success it records, in $GITHUB_ENV when set and on
# stdout always,
#   SETTLE_CODE_SHA=<sha>        the reviewed code this run may execute
#   SETTLE_CHECKED_HEAD=<HEAD>   the exact commit that passed
# and daily_settle.sh --live refuses to run without them, refuses if HEAD is
# ever anything but that commit plus its own data commits, and never pulls.
#
# A local live run is the same two steps by hand:
#   git show <sha>:ops/settle-preflight.sh | bash -s -- settle <sha> > /tmp/env
#   env $(cat /tmp/env) ./daily_settle.sh --live
set -Eeuo pipefail

mode="${1:-}"
sha="${2:-}"
python_bin="${PYTHON_BIN:-python3}"

die() {
  echo "settle-preflight: $*" >&2
  exit 1
}

[[ "$mode" == settle || "$mode" == check ]] || die "usage: settle-preflight.sh settle|check <reviewed-commit>"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "the reviewed commit must be a full 40-hex SHA, got '$sha'"
git rev-parse --verify --quiet "$sha^{commit}" > /dev/null || die "commit $sha is not in this checkout"

branch="$(git symbolic-ref --quiet --short HEAD || true)"
[[ -n "$branch" ]] || die "detached HEAD; check out the data branch first"
[[ "$branch" != main ]] || die "refusing to run on main"

# Nothing uncommitted or untracked may ride along into a checked run.
dirty="$(git status --porcelain --untracked-files=all)"
[[ -z "$dirty" ]] || die "the checkout is not clean:
$dirty"

if [[ "$mode" == settle ]]; then
  if ! git merge --quiet --no-edit "$sha"; then
    git merge --abort 2> /dev/null || true
    die "merging $sha into $branch conflicts; resolve it by hand (main's code wins, data is kept)"
  fi
else
  git merge-base --is-ancestor "$sha" HEAD || die "HEAD does not contain the reviewed commit $sha"
fi

# Main's own copy of the code check: the branch can't loosen it.
git show "$sha:ops/code-matches-main.sh" | bash -s -- --allow-verified "$sha" ||
  die "the data branch carries code that is not in $sha"

# The code check passed, so scripts/verify_data.py here is main's.
"$python_bin" scripts/verify_data.py --base "$sha" || die "verify_data refused the data (see above)"

head="$(git rev-parse HEAD)"
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || die "the check left the checkout dirty"
{
  echo "SETTLE_CODE_SHA=$sha"
  echo "SETTLE_CHECKED_HEAD=$head"
} | tee -a "${GITHUB_ENV:-/dev/null}"
echo "settle-preflight: $branch at $head runs only the code of $sha" >&2
