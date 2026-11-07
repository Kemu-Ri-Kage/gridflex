#!/usr/bin/env bash
# Prints one secret for daily_settle.sh ($SETTLE_SECRET_CMD) from the macOS
# Keychain, for the Mac (launchd) host. Store each one once, typed at the
# prompt so it never lands in shell history:
#   security add-generic-password -a "$USER" -s gridflex-reporter-password -w
#   security add-generic-password -a "$USER" -s gridflex-settler-password -w
set -euo pipefail
case "${1:-}" in
  reporter-password | settler-password) ;;
  *)
    echo "secret-from-keychain: unknown secret '${1:-}'" >&2
    exit 2
    ;;
esac
security find-generic-password -a "$USER" -s "gridflex-$1" -w | tr -d '\n'
