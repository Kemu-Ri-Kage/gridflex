#!/usr/bin/env bash
# Exits 0 only when the checked-out commit runs exactly main's code: every
# path that differs from <base> is a data file the settle job and
# ./refresh_data.sh write, and a plain file. Anything else (a script, a
# workflow, a lockfile, shared/pins.json, a symlink, a renamed or oddly
# named path) fails, and the job stops before any secret is read.
#
#   code-matches-main.sh <base>                     strict
#   code-matches-main.sh --allow-verified <base>    also allow the three
#       address-bearing files below, which only scripts/verify_data.py may
#       approve: the caller must run it next (ops/settle-preflight.sh does)
#
# <base> is the exact reviewed commit ($GITHUB_SHA on GitHub), never a
# moving ref. The workflow runs main's copy of this file, never the branch's:
#   git show "$GITHUB_SHA":ops/code-matches-main.sh | bash -s -- "$GITHUB_SHA"
# so a change to feat/judging-sprint can't loosen the check it is held to.
#
# Why: the settle job runs on feat/judging-sprint, where the data lives, but
# main is the protected branch (pull request + review). Requiring the two to
# differ only in data means the code that can read the keys is code that
# went through review. Contract and market addresses are not free data
# (audit finding S3): they choose the contracts the site's wallets and the
# settler sign against.
set -euo pipefail

allow_verified=0
if [[ "${1:-}" == "--allow-verified" ]]; then
  allow_verified=1
  shift
fi
base="${1:-}"
if [[ -z "$base" ]]; then
  echo "code-matches-main: usage: code-matches-main.sh [--allow-verified] <reviewed-commit>" >&2
  exit 2
fi
git rev-parse --verify --quiet "$base^{commit}" > /dev/null || {
  echo "code-matches-main: no such commit '$base'" >&2
  exit 2
}

# Free data: metric and ledger JSON and the site's derived JSON, except the
# site's copy of the addresses.
data='^(data/metrics/[A-Za-z0-9_]+__[0-9]{4}-[0-9]{2}-[0-9]{2}\.json|data/(publish|market)-ledger\.json|web/public/data/[A-Za-z0-9_-]+\.json|web/public/data/candles/[A-Za-z0-9_-]+\.json|web/lib/generated/[A-Za-z0-9_-]+\.json)$'
# Address-bearing data: may differ only with verify_data.py's approval.
verified='^(shared/addresses\.json|shared/demo-markets\.md|web/public/data/addresses\.json)$'

bad=()
needs_verify=()
# --raw: ":<old mode> <new mode> <old sha> <new sha> <status>\t<path>".
# --no-renames reports a rename as a delete plus an add, so both paths are checked.
while IFS=$'\t' read -r meta path; do
  [[ -z "$meta" ]] && continue
  read -r _ new_mode _ _ status <<< "$meta"
  if [[ "$path" =~ $verified ]]; then
    if [[ "$allow_verified" != 1 ]]; then
      bad+=("$path (addresses: only verify_data.py may approve a change)")
    elif [[ "$status" == "D" ]]; then
      bad+=("$path (deleted)")
    elif [[ "$new_mode" != "100644" ]]; then
      bad+=("$path (mode $new_mode, not a plain file)")
    else
      needs_verify+=("$path")
    fi
  elif [[ ! "$path" =~ $data ]]; then
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
if (( ${#needs_verify[@]} )); then
  echo "Code matches $base ($(git rev-parse --short "$base")); data differs, and these need scripts/verify_data.py:"
  printf '  %s\n' "${needs_verify[@]}"
else
  echo "Code matches $base ($(git rev-parse --short "$base")); only data differs."
fi
