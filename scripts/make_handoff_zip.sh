#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
default_name="gridflex-handoff-$(date -u +%Y%m%d-%H%M).zip"
output_path="${1:-$repo_root/../$default_name}"

if [[ "$output_path" != *.zip ]]; then
  echo "Output path must end in .zip" >&2
  exit 1
fi

"$repo_root/scripts/check_all.sh"

temp_root="$(mktemp -d "${TMPDIR:-/tmp}/gridflex-handoff.XXXXXX")"
trap 'rm -rf "$temp_root"' EXIT
mkdir -p "$temp_root/gridflex"

rsync -a \
  --exclude '.git/' \
  --exclude '.env' \
  --exclude '.DS_Store' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude 'data/raw/' \
  --exclude 'logs/' \
  --exclude 'contracts/cache/' \
  --exclude 'contracts/out/' \
  --exclude 'contracts/broadcast/' \
  --exclude 'web/node_modules/' \
  --exclude 'web/.next/' \
  --exclude 'web/dist/' \
  --exclude 'web/.wrangler/' \
  --include 'web/.env.example' \
  --exclude 'web/.env*' \
  "$repo_root/" "$temp_root/gridflex/"

mkdir -p "$(dirname "$output_path")"
(
  cd "$temp_root"
  zip -qr "$output_path" gridflex
)

echo "Created safe handoff archive: $output_path"
