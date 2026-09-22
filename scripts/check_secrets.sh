#!/usr/bin/env bash
# Check that no GridStatus API key (or any .env file) is in the repository's
# git history, on any branch, and that the built site's JavaScript does not
# contain the key currently in the environment.
#
#   ./scripts/check_secrets.sh            history only
#   ./scripts/check_secrets.sh --build    history, then web/dist after `pnpm build`
#
# Nothing here prints the key. If GRIDSTATUS_API_KEY is set (or in .env), its
# value is compared against the build output and only "found"/"not found" is
# printed.
#
# A clean run does not make a previously disclosed key safe. Rotate exposed
# credentials in GridStatus (Settings > API).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

check_build=0
for arg in "$@"; do
  case "$arg" in
    --build) check_build=1 ;;
    -h | --help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

failed=0

echo "[1/3] .env files in git history (any branch)"
env_blobs="$(git rev-list --all | while read -r commit; do
  git ls-tree -r --name-only "$commit" | grep -E '(^|/)\.env(\.local|\.production|\.development)?$' || true
done | sort -u)"
if [[ -n "$env_blobs" ]]; then
  echo "  FOUND committed env files:" >&2
  echo "$env_blobs" | sed 's/^/    /' >&2
  failed=1
else
  echo "  none"
fi

echo "[2/3] GRIDSTATUS_API_KEY assignments with a real-looking value in history"
# Anything after '=' or ':' that is not a placeholder or a shell variable.
assignments="$(git rev-list --all | while read -r commit; do
  git grep -h -I -E 'GRIDSTATUS_API_KEY[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9_\-]{16,}' "$commit" -- . 2>/dev/null || true
done | { grep -v -E 'paste_your_key_here|your_key_here|\$\{?GRIDSTATUS' || true; } | sort -u)"
if [[ -n "$assignments" ]]; then
  echo "  FOUND $(echo "$assignments" | wc -l | tr -d ' ') line(s) - inspect with 'git log -S' (values not printed)" >&2
  failed=1
else
  echo "  none"
fi

echo "[3/3] The key's value in the working tree and the built site"
key="${GRIDSTATUS_API_KEY:-}"
if [[ -z "$key" && -f .env ]]; then
  key="$(grep -E '^GRIDSTATUS_API_KEY=' .env | head -1 | cut -d= -f2- | tr -d "\"'" || true)"
fi
if [[ -z "$key" || "$key" == "paste_your_key_here" ]]; then
  echo "  skipped: GRIDSTATUS_API_KEY not set and .env has no real key"
else
  # Working tree, excluding .env itself and the ignored raw cache.
  if grep -rIl --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=raw --exclude-dir=dist --exclude=.env -F "$key" . >/dev/null 2>&1; then
    echo "  FOUND the key in tracked or untracked files:" >&2
    grep -rIl --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=raw --exclude-dir=dist --exclude=.env -F "$key" . | sed 's/^/    /' >&2
    failed=1
  else
    echo "  working tree: not found"
  fi
  if git rev-list --all | while read -r commit; do git grep -q -F "$key" "$commit" -- . 2>/dev/null && echo hit; done | grep -q hit; then
    echo "  FOUND the key in git history" >&2
    failed=1
  else
    echo "  git history: not found"
  fi
  if [[ "$check_build" == 1 ]]; then
    if [[ ! -d web/dist ]]; then
      echo "  web/dist missing: run 'pnpm build' in web/ first" >&2
      failed=1
    elif grep -rIl -F "$key" web/dist >/dev/null 2>&1; then
      echo "  FOUND the key in web/dist" >&2
      failed=1
    else
      echo "  web/dist: not found"
    fi
  fi
fi

if [[ "$failed" == 1 ]]; then
  echo
  echo "Secrets check FAILED. Rotate the key in GridStatus and remove it from the paths above." >&2
  exit 1
fi
echo
echo "Secrets check passed. Remember: a previously disclosed key still needs rotating."
