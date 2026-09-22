#!/usr/bin/env bash
# Refresh GRIDFLEX market data on demand and redeploy the site.
#
#   ./refresh_data.sh              fetch, rebuild, build the site, deploy it
#   ./refresh_data.sh --no-deploy  everything except the deploy
#
# Steps: latest ERCOT prices (fetch_ercot.py, last 3 days, no fuel mix -
# the site doesn't show it), candles (build_candles.py), feed data
# (build_feed_data.py), `pnpm build`, then `wrangler deploy` of the built
# worker. Prints the GridStatus rows the refresh used.
#
# Needs GRIDSTATUS_API_KEY - taken from the environment, or loaded from .env
# without ever being printed - and a logged-in wrangler for the deploy.
# Runs in the foreground and starts nothing that outlives it; Ctrl-C stops it.
# It does not publish anything onchain and does not commit.
set -euo pipefail

deploy=1
for arg in "$@"; do
  case "$arg" in
    --no-deploy) deploy=0 ;;
    -h | --help)
      sed -n '2,15p' "$0"
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

# Days of prices to re-read each refresh: yesterday (the newest complete
# market day the pipeline can reach) plus the two before it, which is the
# window fetch_ercot.py treats as not yet final.
fetch_days=3

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

echo "[1/5] Fetching the latest ERCOT prices"
"$python_bin" fetch_ercot.py --days "$fetch_days" --skip-fuelmix | tee "$run_log"

echo
echo "[2/5] Rebuilding candle data"
"$python_bin" build_candles.py | tee -a "$run_log"

echo
echo "[3/5] Rebuilding feed data"
"$python_bin" build_feed_data.py

rows_used="$(
  grep -o 'GridStatus rows fetched this run: [0-9,]*' "$run_log" |
    awk -F': ' '{ gsub(",", "", $2); total += $2 } END { print total + 0 }'
)"

echo
echo "[4/5] Building the site"
(cd "$repo_root/web" && "$pnpm_bin" build)

echo
if [[ "$deploy" == 1 ]]; then
  echo "[5/5] Deploying the site"
  (cd "$repo_root/web" && "$pnpm_bin" exec wrangler deploy --config dist/server/wrangler.json)
else
  echo "[5/5] Deploy skipped (--no-deploy)"
fi

echo
echo "GridStatus rows used by this refresh: $rows_used"
