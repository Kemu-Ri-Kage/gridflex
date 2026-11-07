#!/usr/bin/env bash
# Exits 0 only when the checked-out commit runs exactly main's code: every
# path that differs from <base> (default origin/main) is a data file the
# settle job and ./refresh_data.sh write, and a plain file. Anything else
# (a script, a workflow, a lockfile, a symlink, a renamed or oddly named
# path) fails, and the job stops before any secret is read.
#
# The workflow runs main's copy of this file, never the branch's:
#   git show origin/main:ops/code-matches-main.sh | bash -s -- origin/main
# so a change to feat/judging-sprint can't loosen the check it is held to.
#
# Why: the settle job runs on feat/judging-sprint, where the data lives, but
# main is the protected branch (pull request + review). Requiring the two to
# differ only in data means the code that can read the keys is code that
# went through review.
set -euo pipefail

base="${1:-origin/main}"
git rev-parse --verify --quiet "$base^{commit}" > /dev/null || {
  echo "code-matches-main: no such commit '$base'" >&2
  exit 2
}

# The data paths: metric and ledger JSON, the site's derived JSON, the
# deployed addresses and the market table.
data='^(data/metrics/[A-Za-z0-9_]+__[0-9]{4}-[0-9]{2}-[0-9]{2}\.json|data/(publish|market)-ledger\.json|web/public/data/[A-Za-z0-9_-]+\.json|web/public/data/candles/[A-Za-z0-9_-]+\.json|web/lib/generated/[A-Za-z0-9_-]+\.json|shared/addresses\.json|shared/demo-markets\.md)$'

bad=()
# --raw: ":<old mode> <new mode> <old sha> <new sha> <status>\t<path>".
# --no-renames reports a rename as a delete plus an add, so both paths are checked.
while IFS=$'\t' read -r meta path; do
  [[ -z "$meta" ]] && continue
  read -r _ new_mode _ _ status <<< "$meta"
  if [[ ! "$path" =~ $data ]]; then
    bad+=("$path (not a data file)")
  elif [[ "$new_mode" != "100644" && "$status" != "D" ]]; then
    bad+=("$path (mode $new_mode, not a plain file)")
  fi
done < <(git diff --raw --no-renames --no-ext-diff --no-textconv "$base" HEAD --)

if (( ${#bad[@]} )); then
  echo "Refusing to run: $(git rev-parse --short HEAD) has code that is not on $base:" >&2
  printf '  %s\n' "${bad[@]}" >&2
  echo "Merge that change into main through a reviewed pull request first." >&2
  exit 1
fi
echo "Code matches $base ($(git rev-parse --short "$base")); only data differs."
