#!/usr/bin/env bash
# A filter: copies stdin to stdout with the value of every secret the settle
# job can hold replaced by [REDACTED] (audit finding S9, belt and braces: no
# step is meant to print one). daily_settle.sh runs its log and every
# Telegram text through it.
#
#   some-command 2>&1 | ops/redact.sh
#
# Values shorter than 6 characters are left alone (they would redact common
# words); a Telegram bot token or healthchecks ping URL embedded in text is
# also caught by shape.
set -uo pipefail

names=(TELEGRAM_BOT_TOKEN HC_PING_URL GRIDSTATUS_API_KEY REPORTER_KEYSTORE_PASSWORD
  SETTLER_KEYSTORE_PASSWORD REPORTER_KEYSTORE_JSON SETTLER_KEYSTORE_JSON
  REPORTER_PRIVATE_KEY FINALIZER_PRIVATE_KEY CLOUDFLARE_API_TOKEN GITHUB_TOKEN GH_TOKEN
  ACTIONS_RUNTIME_TOKEN ACTIONS_ID_TOKEN_REQUEST_TOKEN)
secrets=()
for name in "${names[@]}"; do
  value="${!name:-}"
  (( ${#value} >= 6 )) && secrets+=("$value")
done

bot_token='[0-9]{6,}:[A-Za-z0-9_-]{30,}'
ping_url='hc-ping\.com/[A-Za-z0-9_-]{8,}(/[A-Za-z0-9_-]+)?'

redact_line() {
  local line="$1" secret
  for secret in ${secrets[@]+"${secrets[@]}"}; do
    line="${line//"$secret"/[REDACTED]}"
  done
  while [[ "$line" =~ $bot_token ]]; do line="${line//"${BASH_REMATCH[0]}"/[REDACTED]}"; done
  while [[ "$line" =~ $ping_url ]]; do line="${line//"${BASH_REMATCH[0]}"/hc-ping.com/[REDACTED]}"; done
  printf '%s' "$line"
}

while IFS= read -r line || [[ -n "$line" ]]; do
  redact_line "$line"
  printf '\n'
done
