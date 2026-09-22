#!/usr/bin/env bash
# Refresh GRIDFLEX market data on demand, commit it, and redeploy the site.
#
#   ./refresh_data.sh              fetch, rebuild, commit, push, build, deploy
#   ./refresh_data.sh --no-deploy  everything except the deploy
#
# Steps: ERCOT prices (fetch_ercot.py: today, the last 3 days, and every day
# missing since the latest complete day - no fuel mix, the site doesn't show
# it), candles (build_candles.py), feed data (build_feed_data.py), a commit of
# the regenerated data files on the current branch, a push, `pnpm build`, then
# `wrangler deploy` of the built worker. Prints the GridStatus rows it used.
#
# Refuses to run on main. Deploys only what is committed and pushed: it stops
# before fetching if anything under web/ other than web/public/data/ has
# uncommitted changes, and again before building if anything is left over.
#
# Needs GRIDSTATUS_API_KEY - taken from the environment, or loaded from .env
# without ever being printed - and a logged-in wrangler for the deploy.
# Runs in the foreground and starts nothing that outlives it; Ctrl-C stops it.
# It does not publish anything onchain.
set -euo pipefail

deploy=1
for arg in "$@"; do
  case "$arg" in
    --no-deploy) deploy=0 ;;
    -h | --help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (see --help)" >&2
      exit 2
      ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_root"

python_bin="${PYTHON_BIN:-}"
if [[ -z "$python_bin" ]]; then
  if [[ -x "$repo_root/.venv/bin/python" ]]; then
    python_bin="$repo_root/.venv/bin/python"
  else
    python_bin="python3"
  fi
fi
pnpm_bin="${PNPM_BIN:-pnpm}"
git_remote="${GIT_REMOTE:-origin}"

# Days of prices to re-read each refresh besides today: the window
# fetch_ercot.py treats as not yet final. Days older than that which were
# never fetched are filled by --fill-gaps.
fetch_days=3

# The files this script regenerates, and so the only ones it commits.
data_paths=(data/metrics web/public/data)

# Everything the site build reads from the repo.
build_paths=(web data/metrics)

branch="$(git symbolic-ref --quiet --short HEAD || true)"
if [[ -z "$branch" ]]; then
  echo "Not on a branch (detached HEAD). Check out a feature branch first." >&2
  exit 1
fi
if [[ "$branch" == "main" ]]; then
  echo "Refusing to run on main. Check out a feature branch first." >&2
  exit 1
fi

# The site is built from the working tree, so anything uncommitted under web/
# would ship without being in any commit. Only web/public/data/ may differ:
# this run regenerates and commits it.
dirty="$(git status --porcelain --untracked-files=all -- web ':(exclude)web/public/data')"
if [[ -n "$dirty" ]]; then
  echo "Uncommitted changes under web/ would be deployed without a commit:" >&2
  echo "$dirty" >&2
  echo "Commit or stash them first." >&2
  exit 1
fi

if [[ -z "${GRIDSTATUS_API_KEY:-}" && -f "$repo_root/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$repo_root/.env"
  set +a
fi
if [[ -z "${GRIDSTATUS_API_KEY:-}" ]]; then
  echo "GRIDSTATUS_API_KEY is not set and .env did not provide it." >&2
  exit 1
fi

run_log="$(mktemp)"
trap 'rm -f "$run_log"' EXIT

echo "[1/6] Fetching ERCOT prices"
"$python_bin" fetch_ercot.py --days "$fetch_days" --fill-gaps --skip-fuelmix | tee "$run_log"

echo
echo "[2/6] Rebuilding candle data"
"$python_bin" build_candles.py | tee -a "$run_log"

echo
echo "[3/6] Rebuilding feed data"
"$python_bin" build_feed_data.py

rows_used="$(
  grep -o 'GridStatus rows fetched this run: [0-9,]*' "$run_log" |
    awk -F': ' '{ gsub(",", "", $2); total += $2 } END { print total + 0 }'
)"

echo
echo "[4/6] Committing and pushing the data on $branch"
git add -A -- "${data_paths[@]}"
if git diff --cached --quiet -- "${data_paths[@]}"; then
  echo "No data changed; nothing to commit."
else
  # --only (the pathspec) commits the data paths alone, whatever else is staged.
  git commit --quiet -m "Refresh market data, $(date -u +%Y-%m-%d)" -- "${data_paths[@]}"
  git log -1 --format='  %h %s'
fi
git push --quiet "$git_remote" "HEAD:refs/heads/$branch"

leftover="$(git status --porcelain --untracked-files=all -- "${build_paths[@]}")"
if [[ -n "$leftover" ]]; then
  echo "Not deploying: these build inputs differ from the commit:" >&2
  echo "$leftover" >&2
  exit 1
fi
commit="$(git rev-parse --short HEAD)"

echo
echo "[5/6] Building the site from $commit"
(cd "$repo_root/web" && "$pnpm_bin" build)

echo
if [[ "$deploy" == 1 ]]; then
  echo "[6/6] Deploying $commit"
  (cd "$repo_root/web" && "$pnpm_bin" exec wrangler deploy --config dist/server/wrangler.json)
else
  echo "[6/6] Deploy skipped (--no-deploy)"
fi

echo
echo "GridStatus rows used by this refresh: $rows_used"
