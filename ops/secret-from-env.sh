#!/usr/bin/env bash
# Prints one secret for daily_settle.sh ($SETTLE_SECRET_CMD) from the
# environment, as GitHub Actions provides its secrets. Prints nothing else.
#   reporter-password  REPORTER_KEYSTORE_PASSWORD
#   settler-password   SETTLER_KEYSTORE_PASSWORD
set -euo pipefail
case "${1:-}" in
  reporter-password) var=REPORTER_KEYSTORE_PASSWORD ;;
  settler-password) var=SETTLER_KEYSTORE_PASSWORD ;;
  *)
    echo "secret-from-env: unknown secret '${1:-}'" >&2
    exit 2
    ;;
esac
if [[ -z "${!var:-}" ]]; then
  echo "secret-from-env: $var is not set" >&2
  exit 1
fi
printf '%s' "${!var}"
