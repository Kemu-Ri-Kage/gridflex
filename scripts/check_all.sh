#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python_bin="${PYTHON_BIN:-}"
pnpm_bin="${PNPM_BIN:-pnpm}"
forge_bin="${FORGE_BIN:-}"
node_bin_dir=""

if [[ -z "$python_bin" ]]; then
  if [[ -x "$repo_root/.venv/bin/python" ]]; then
    python_bin="$repo_root/.venv/bin/python"
  else
    python_bin="python3"
  fi
fi

if command -v node >/dev/null 2>&1; then
  node_bin_dir="$(dirname "$(command -v node)")"
fi

if [[ -z "$forge_bin" ]]; then
  if command -v forge >/dev/null 2>&1; then
    forge_bin="$(command -v forge)"
  elif [[ -x "$repo_root/../../tools/foundry-v1.8.1/forge" ]]; then
    forge_bin="$repo_root/../../tools/foundry-v1.8.1/forge"
  else
    echo "Foundry is required. Install it or set FORGE_BIN." >&2
    exit 1
  fi
fi

if ! "$python_bin" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "Python 3.10 or newer is required; found $($python_bin --version 2>&1)." >&2
  exit 1
fi

echo "[1/3] Validating ERCOT data and running the complete Python test suite"
"$python_bin" "$repo_root/scripts/validate_metrics.py"
PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/gridflex-pycache" \
  "$python_bin" -m py_compile \
    "$repo_root/fetch_ercot.py" \
    "$repo_root/analyse_metrics.py" \
    "$repo_root/build_candles.py" \
    "$repo_root/build_feed_data.py" \
    "$repo_root/create_markets.py" \
    "$repo_root/publish.py" \
    "$repo_root/finalize.py" \
    "$repo_root/resolve_markets.py" \
    "$repo_root/claim_liquidity.py" \
    "$repo_root/verify_reading.py" \
    "$repo_root/fund_demo_wallet.py"
(
  cd "$repo_root"
  PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/gridflex-pycache" \
    "$python_bin" -m unittest discover -s tests -v
)

echo "[2/3] Testing Solidity contracts"
(
  cd "$repo_root/contracts"
  "$forge_bin" fmt --check
  "$forge_bin" test
  "$python_bin" scripts/export_abi.py
)
"$python_bin" "$repo_root/scripts/validate_contract_interface.py"

echo "[3/3] Checking the web application"
(
  cd "$repo_root/web"
  if [[ -n "$node_bin_dir" ]]; then
    export PATH="$node_bin_dir:$PATH"
  fi
  "$pnpm_bin" install --frozen-lockfile
  "$pnpm_bin" test
  "$pnpm_bin" lint
  "$pnpm_bin" build
)

echo "All GRIDFLEX checks passed."
