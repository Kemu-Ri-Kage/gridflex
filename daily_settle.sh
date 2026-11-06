#!/usr/bin/env bash
# The daily settle job: one run does whatever is due, then stops.
#
#   ./daily_settle.sh              fetch, publish, wait, finalize, resolve,
#                                  extend the market ladder, redeploy, check
#   ./daily_settle.sh --dry-run    every step in dry-run mode: nothing is sent,
#                                  committed, pushed or deployed, nothing fetched
#   ./daily_settle.sh --no-deploy  everything except the site deploy
#
# Spec: docs/specs/2026-10-13-daily-settle.md. Every decision comes from the
# chain at one block plus the committed files (scripts/settle_due.py), never
# from an earlier run, so it is safe to run as often as you like: the main
# run is 00:20 UTC, with catch-up runs at 03:20, 09:20 and 15:20.
#
# Steps:
#   0  lock, and stop if a hold is set (SETTLE_HOLD=1 or $SETTLE_HOLD_FILE)
#   1  sync the live branch ($SETTLE_BRANCH, default feat/judging-sprint)
#   2  plan          scripts/settle_due.py
#   3  fetch         ./refresh_data.sh --requests-lifted --no-deploy, only when
#                    a due day has no metric file
#   4  publish       publish.py --live --yes (reporter key), ledger committed
#   5  wait          out the one-hour dispute window (at most 75 minutes)
#   6  finalize      finalize.py --live --yes (settler key), held if a value is
#                    outside -$50..$1,000/MWh
#   7  resolve       resolve_markets.py --live --yes (settler key)
#   8  ladder        when no market day is after tomorrow: add the next week's
#                    rows (scripts/extend_ladder.py) and create them
#                    (create_markets.py --live --yes, settler key)
#   9  redeploy      ./refresh_data.sh --no-fetch, when anything changed
#  10  verify        scripts/settle_due.py --check; any alert fails the run
#
# Stop words never retry, they alert and stop for a person: "may still be in
# flight", "VALUE MISMATCH", "differs from immutable", "Resolved event says",
# "CORRECTION". Any other failed chain step is retried once after 120 s.
#
# Secrets never appear on the command line, in the environment of child
# commands that don't need them, or in the logs. Keystore passwords come from
# $SETTLE_SECRET_CMD <name> (ops/secret-from-env.sh on GitHub,
# ops/secret-from-keychain.sh on a Mac) and reach the scripts through a pipe
# (<ROLE>_KEYSTORE_PASSWORD_FILE=/dev/fd/3). The keystores themselves are
# named by REPORTER_KEYSTORE_PATH and SETTLER_KEYSTORE_PATH.
#
# Alerts (all optional): TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, and
# HC_PING_URL (healthchecks.io: /start, success, /fail).
#
# To stop a run before it finalizes: set the hold (GitHub:
#   gh variable set SETTLE_HOLD --body 1   Mac: touch ~/.gridflex-settle-hold)
# To stop the schedule: gh workflow disable daily-settle
set -euo pipefail

dry_run="${SETTLE_DRY_RUN:-0}"
deploy=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --no-deploy) deploy=0 ;;
    -h | --help)
      sed -n '2,50p' "$0"
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
git_remote="${GIT_REMOTE:-origin}"
branch_wanted="${SETTLE_BRANCH:-feat/judging-sprint}"
hold_file="${SETTLE_HOLD_FILE:-$HOME/.gridflex-settle-hold}"
secret_cmd="${SETTLE_SECRET_CMD:-}"
metric="ERCOT_HBNORTH_DA_AVG"
retry_seconds="${SETTLE_RETRY_SECONDS:-120}"
max_wait_seconds="${SETTLE_MAX_WAIT_SECONDS:-4500}"   # 75 minutes
stop_words='may still be in flight|VALUE MISMATCH|differs from immutable|Resolved event says|CORRECTION'

log_dir="$repo_root/logs"
mkdir -p "$log_dir"
run_id="$(date -u +%Y%m%dT%H%M%SZ)"
run_log="$log_dir/settle-$run_id.log"
plan_json="$log_dir/plan.json"
lock_dir="$repo_root/.settle.lock"
current_step="start"
changed=0

# ------------------------------------------------------------------ alerts

notify() {
  # Telegram, when configured. The token is only ever passed to curl.
  local text="$1"
  echo "$text"
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
    curl -fsS -m 15 -o /dev/null \
      --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=GRIDFLEX settle: ${text}" \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" || true
  fi
}

hc_ping() {
  # healthchecks.io: "" (success), "/start" or "/fail"; the fail body is the log tail.
  [[ -z "${HC_PING_URL:-}" ]] && return 0
  if [[ "$1" == "/fail" ]]; then
    tail -n 60 "$run_log" | curl -fsS -m 15 --retry 3 -o /dev/null --data-binary @- "${HC_PING_URL}/fail" || true
  else
    curl -fsS -m 15 --retry 3 -o /dev/null "${HC_PING_URL}$1" || true
  fi
}

fail() {
  notify "FAILED at step '$current_step': $1. Next: run ./daily_settle.sh --dry-run and read logs/settle-$run_id.log."
  hc_ping /fail
  exit 1
}

on_error() {
  local code=$?
  notify "FAILED at step '$current_step' (exit $code). See logs/settle-$run_id.log."
  hc_ping /fail
  exit "$code"
}

cleanup() {
  rmdir "$lock_dir" 2>/dev/null || true
}

# Everything this run prints also goes to its log.
exec > >(tee -a "$run_log") 2>&1

# ------------------------------------------------------------------ helpers

step() {
  current_step="$1"
  echo
  echo "== [$1] $(date -u +%H:%M:%SZ)"
}

held() {
  [[ "${SETTLE_HOLD:-0}" == "1" || -e "$hold_file" ]]
}

plan_field() {
  # One field of logs/plan.json as plain text, the way settle_due.py --get
  # prints it (true/false, "" for null, lists as space-separated dayKeys),
  # without re-reading the chain.
  "$python_bin" - "$plan_json" "$1" <<'PY'
import json, sys
value = json.load(open(sys.argv[1])).get(sys.argv[2])
if value is None:
    print("")
elif isinstance(value, bool):
    print("true" if value else "false")
elif isinstance(value, list):
    print(" ".join(str(v.get("dayKey", v)) if isinstance(v, dict) else str(v) for v in value))
else:
    print(value)
PY
}

replan() {
  # settle_due exits 0 (fine) or 3 (alerts, which only matter at step 10);
  # 2 means the chain or files couldn't be read: retry once.
  local code=0
  "$python_bin" scripts/settle_due.py --json "$plan_json" || code=$?
  if [[ "$code" == 2 ]]; then
    echo "Plan failed; retrying in ${retry_seconds}s"
    sleep "$retry_seconds"
    code=0
    "$python_bin" scripts/settle_due.py --json "$plan_json" || code=$?
  fi
  [[ "$code" == 0 || "$code" == 3 ]] || fail "could not read the chain to plan the run"
}

with_secret() {
  # with_secret <secret-name> <ENV_NAME_FOR_FD> <command...>: the secret goes
  # down fd 3, and the command is told to read its password from /dev/fd/3.
  local name="$1" env_name="$2"
  shift 2
  if [[ "$dry_run" == 1 ]]; then
    "$@"
    return
  fi
  [[ -n "$secret_cmd" ]] || fail "SETTLE_SECRET_CMD is not set; cannot read the $name"
  env "$env_name=/dev/fd/3" "$@" 3< <("$secret_cmd" "$name")
}

chain_step() {
  # chain_step <label> <secret-name> <PASSWORD_ENV> <command...>
  # Runs a chain-writing script; a stop word alerts and stops, any other
  # failure is retried once.
  local label="$1" secret="$2" env_name="$3"
  shift 3
  local out="$log_dir/$label-$run_id.out" code
  for attempt in 1 2; do
    code=0
    with_secret "$secret" "$env_name" "$@" > >(tee "$out") 2>&1 || code=$?
    sleep 1   # let tee finish writing $out
    if grep -Eq "$stop_words" "$out"; then
      fail "$label hit a stop word ($(grep -Eo "$stop_words" "$out" | head -1)); a person must look"
    fi
    [[ "$code" == 0 ]] && return 0
    [[ "$attempt" == 1 ]] && { echo "$label failed (exit $code); retrying in ${retry_seconds}s"; sleep "$retry_seconds"; }
  done
  fail "$label failed twice (exit $code)"
}

commit_ledger() {
  # Commits data/publish-ledger.json alone, by pathspec, and pushes.
  local message="$1"
  if [[ "$dry_run" == 1 ]]; then
    echo "(dry run) would commit: $message"
    return
  fi
  git add -- data/publish-ledger.json
  if git diff --cached --quiet -- data/publish-ledger.json; then
    echo "Ledger unchanged; nothing to commit."
    return
  fi
  git commit --quiet -m "$message" -- data/publish-ledger.json
  git push --quiet "$git_remote" "HEAD:refs/heads/$branch_wanted" ||
    fail "push rejected (someone pushed meanwhile); the next run starts from a fresh pull"
  changed=1
}

# ------------------------------------------------------------------ 0. lock and hold

if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "Another settle run holds $lock_dir; exiting."
  exit 0
fi
trap cleanup EXIT
trap on_error ERR

step "0 hold"
if held; then
  echo "Hold is set (SETTLE_HOLD=1 or $hold_file); nothing done."
  exit 0
fi
[[ "$dry_run" == 1 ]] && echo "DRY RUN: nothing will be sent, committed, pushed, deployed or fetched."
hc_ping /start

# ------------------------------------------------------------------ 1. sync

step "1 sync"
branch="$(git symbolic-ref --quiet --short HEAD || true)"
[[ -n "$branch" ]] || fail "detached HEAD; check out $branch_wanted"
[[ "$branch" != "main" ]] || fail "refusing to run on main"
if [[ "$dry_run" != 1 ]]; then
  git fetch --quiet "$git_remote"
  if [[ "$branch" != "$branch_wanted" ]]; then
    git checkout --quiet "$branch_wanted"
  fi
  git pull --quiet --ff-only "$git_remote" "$branch_wanted"
fi
echo "On $(git symbolic-ref --short HEAD) at $(git rev-parse --short HEAD)"

# ------------------------------------------------------------------ 2. plan

step "2 plan"
replan

# ------------------------------------------------------------------ 3. fetch

step "3 fetch"
if [[ "$(plan_field fetchNeeded)" == "true" ]]; then
  if [[ "$dry_run" == 1 ]]; then
    echo "(dry run) would run ./refresh_data.sh --requests-lifted --no-deploy"
  elif ./refresh_data.sh --requests-lifted --no-deploy; then
    "$python_bin" scripts/validate_metrics.py
    changed=1
    replan
  else
    # No retry inside a run: the GridStatus budget is metered. The next
    # scheduled run tries again, and step 10 alerts on anything overdue.
    echo "Fetch failed; continuing with what is already committed."
  fi
else
  echo "Nothing to fetch."
fi

# ------------------------------------------------------------------ 4. publish

step "4 publish"
publish_start="$(plan_field publishStart)"
publish_end="$(plan_field publishEnd)"
if [[ -n "$publish_start" ]]; then
  live=(--live --yes)
  [[ "$dry_run" == 1 ]] && live=()
  REPORTER_KEYSTORE_PATH="${REPORTER_KEYSTORE_PATH:-}" \
    chain_step publish reporter-password REPORTER_KEYSTORE_PASSWORD_FILE \
    "$python_bin" publish.py --metric "$metric" --start "$publish_start" --end "$publish_end" \
    --limit 7 ${live[@]+"${live[@]}"}
  commit_ledger "Ledger: $publish_start-$publish_end HBNORTH reading(s) published on chain"
  replan
  seconds="$(plan_field secondsToFinalizable)"
  if [[ -n "$seconds" ]]; then
    finalize_at="$(date -u -d "@$(( $(date +%s) + seconds ))" +%H:%MZ 2>/dev/null ||
      date -u -r "$(( $(date +%s) + seconds ))" +%H:%MZ)"
    notify "Published $publish_start-$publish_end. Finalizes at about $finalize_at. To stop it: gh variable set SETTLE_HOLD --body 1 (or touch $hold_file)."
  fi
else
  echo "Nothing to publish."
fi

# ------------------------------------------------------------------ 5. wait

step "5 wait"
seconds="$(plan_field secondsToFinalizable)"
if [[ -n "$seconds" && "$seconds" -gt 0 ]]; then
  wait_for=$(( seconds + 90 ))
  (( wait_for > max_wait_seconds )) && wait_for=$max_wait_seconds
  if [[ "$dry_run" == 1 ]]; then
    echo "(dry run) would wait ${wait_for}s for the dispute window"
  else
    echo "Waiting ${wait_for}s for the dispute window to end"
    sleep "$wait_for"
    replan
  fi
else
  echo "Nothing waiting."
fi
if held; then
  notify "Hold set during the dispute window; stopped before finalizing."
  exit 0
fi

# ------------------------------------------------------------------ 6. finalize

step "6 finalize"
finalize_start="$(plan_field finalizeStart)"
if [[ -n "$finalize_start" ]]; then
  if [[ -n "$(plan_field outOfRange)" ]]; then
    fail "a published value is outside -\$50..\$1,000/MWh ($(plan_field outOfRange)); finalizing held for a person"
  fi
  live=(--live --yes)
  [[ "$dry_run" == 1 ]] && live=()
  FINALIZER_KEYSTORE_PATH="${SETTLER_KEYSTORE_PATH:-}" \
    chain_step finalize settler-password FINALIZER_KEYSTORE_PASSWORD_FILE \
    "$python_bin" finalize.py --metric "$metric" --start "$finalize_start" --limit 7 \
    ${live[@]+"${live[@]}"}
  commit_ledger "Ledger: HBNORTH reading(s) from $finalize_start finalized on chain"
  replan
else
  echo "Nothing to finalize."
fi

# ------------------------------------------------------------------ 7. resolve

step "7 resolve"
if [[ -n "$(plan_field resolve)" ]]; then
  live=(--live --yes)
  [[ "$dry_run" == 1 ]] && live=()
  FINALIZER_KEYSTORE_PATH="${SETTLER_KEYSTORE_PATH:-}" \
    chain_step resolve settler-password FINALIZER_KEYSTORE_PASSWORD_FILE \
    "$python_bin" resolve_markets.py ${live[@]+"${live[@]}"}
  [[ "$dry_run" == 1 ]] || changed=1
  replan
else
  echo "Nothing to resolve."
fi

# ------------------------------------------------------------------ 8. ladder

step "8 ladder"
if [[ "$(plan_field ladderRunningOut)" == "true" && "${SETTLE_CREATE_MARKETS:-1}" == "1" ]]; then
  ladder_args=()
  [[ "$dry_run" == 1 ]] && ladder_args=(--dry-run)
  rows="$("$python_bin" scripts/extend_ladder.py ${ladder_args[@]+"${ladder_args[@]}"})"
  if [[ -n "$rows" && "$dry_run" == 1 ]]; then
    echo "(dry run) would add and create market rows: $(echo "$rows" | tr '\n' ' ')"
  elif [[ -n "$rows" ]]; then
    market_args=()
    for row in $rows; do market_args+=(--market "$row"); done
    FINALIZER_KEYSTORE_PATH="${SETTLER_KEYSTORE_PATH:-}" \
      chain_step create settler-password FINALIZER_KEYSTORE_PASSWORD_FILE \
      "$python_bin" create_markets.py "${market_args[@]}" --live --yes
    git add -- shared/demo-markets.md shared/addresses.json data/market-ledger.json
    git commit --quiet -m "Markets: next week's ladder created (rows $(echo "$rows" | tr '\n' ' '))" \
      -- shared/demo-markets.md shared/addresses.json data/market-ledger.json
    git push --quiet "$git_remote" "HEAD:refs/heads/$branch_wanted" ||
      fail "push rejected after creating markets; the next run starts from a fresh pull"
    changed=1
    notify "Created next week's markets (rows $(echo "$rows" | tr '\n' ' '))."
  else
    echo "No new market days to add."
  fi
else
  echo "Ladder reaches beyond tomorrow."
fi

# ------------------------------------------------------------------ 9. redeploy

step "9 redeploy"
if [[ "$changed" == 1 && "$deploy" == 1 && "$dry_run" != 1 ]]; then
  ./refresh_data.sh --no-fetch
  scripts/check_secrets.sh --build
else
  echo "Nothing to redeploy."
fi

# ------------------------------------------------------------------ 10. verify

step "10 verify"
check=0
"$python_bin" scripts/settle_due.py --check --json "$plan_json" || check=$?
if [[ "$check" == 3 ]]; then
  fail "alerts after the run: $(plan_field alerts)"
elif [[ "$check" != 0 ]]; then
  fail "could not read the chain to verify the run"
fi
echo
echo "Settle run $run_id finished with no alerts."
hc_ping ""
