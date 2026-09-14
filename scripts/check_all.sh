#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python_bin="${PYTHON_BIN:-python3}"
pnpm_bin="${PNPM_BIN:-pnpm}"
forge_bin="${FORGE_BIN:-}"

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

echo "[1/3] Validating ERCOT metric files and market-day logic"
"$python_bin" "$repo_root/scripts/validate_metrics.py"
PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/gridflex-pycache" \
  "$python_bin" -m py_compile "$repo_root/fetch_ercot.py" "$repo_root/analyse_metrics.py"
(
  cd "$repo_root"
  PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/gridflex-pycache" \
    "$python_bin" -m unittest tests.test_market_day -v
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
  "$pnpm_bin" install --frozen-lockfile
  "$pnpm_bin" lint
  "$pnpm_bin" build
)

echo "All GRIDFLEX checks passed."
