#!/usr/bin/env bash
# The daily settle job: one run does whatever is due, then stops.
#
#   ./daily_settle.sh                 a dry run, the default: plans and prints
#                                     every step; nothing is fetched, sent,
#                                     committed, pushed or deployed
#   ./daily_settle.sh --live          fetch, commit and push the data, redeploy;
#                                     the chain steps still only print
#   ./daily_settle.sh --live --chain  everything: also publish, finalize,
#                                     resolve and create markets on chain
#   --no-deploy                       skip the site deploy (on GitHub a
#                                     separate job, without the keys, deploys)
#   --dry-run                         a dry run, whatever else is given
#
# Nothing goes live by default: without --live (and --chain for the chain)
# a run only reads and prints, and no environment variable changes that.
#
# Spec: docs/specs/2026-10-13-daily-settle.md. Every decision comes from the
# chain at one block plus the committed files (scripts/settle_due.py), never
# from an earlier run, so it is safe to run as often as you like: the main
# run is 00:20 UTC, with catch-up runs at 03:20, 09:20 and 15:20.
#
# Steps:
#   0  lock, and stop if a hold is set (SETTLE_HOLD=1 or $SETTLE_HOLD_FILE)
#   1  sync          pull the live branch ($SETTLE_BRANCH, default
#                    feat/judging-sprint), which must already be checked out:
#                    the script never switches branches while it runs
#   2  plan          scripts/settle_due.py
#   3  fetch         ./refresh_data.sh --requests-lifted --no-build, only when
#                    a due day has no metric file
#   4  publish       publish.py --live --yes (reporter key), ledger committed
#   5  wait          out the one-hour dispute window (at most 75 minutes)
#   6  finalize      finalize.py --live --yes (settler key), held if a value is
#                    outside -$50..$1,000/MWh
#   7  resolve       resolve_markets.py --live --yes (settler key)
#   8  ladder        when no market day is after tomorrow: add the next week's
#                    rows (scripts/extend_ladder.py) and create them
#                    (create_markets.py --live --yes, settler key), once: a
#                    failed create is never retried, since a retry could
#                    create a market twice
#   9  redeploy      ./refresh_data.sh --no-fetch, when anything changed
#  10  verify        scripts/settle_due.py --check; with --chain any alert
#                    fails the run; without it, chain work that is due goes to
#                    Telegram for a person to do by hand
#
# Stop words never retry, they alert and stop for a person: "may still be in
# flight", "VALUE MISMATCH", "differs from immutable", "Resolved event says",
# "CORRECTION". Any other failed publish, finalize or resolve is retried once
# after 120 s (each of those reads the chain before it sends, so a retry
# never repeats a transaction).
#
# Secrets never appear on the command line, in the environment of child
# commands that don't need them, or in the logs, and are read only for live
# chain steps. Keystore passwords come from $SETTLE_SECRET_CMD <name>
# (ops/secret-from-env.sh on GitHub, ops/secret-from-keychain.sh on a Mac)
# and reach the scripts through a pipe (<ROLE>_KEYSTORE_PASSWORD_FILE=
# /dev/fd/3). The keystores themselves are named by REPORTER_KEYSTORE_PATH
# and SETTLER_KEYSTORE_PATH.
#
# Alerts (all optional): TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, and
# HC_PING_URL (healthchecks.io: /start, success, /fail).
#
# To stop a run before it finalizes: set the hold (GitHub:
#   gh variable set SETTLE_HOLD --body 1   Mac: touch ~/.gridflex-settle-hold)
# To stop the schedule: gh workflow disable daily-settle
set -euo pipefail

live=0
chain=0
forced_dry=0
deploy=1
for arg in "$@"; do
  case "$arg" in
    --live) live=1 ;;
    --chain) chain=1 ;;
    --dry-run) forced_dry=1 ;;
    --no-deploy) deploy=0 ;;
    -h | --help)
      sed -n '2,66p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (see --help)" >&2
      exit 2
      ;;
  esac
done
[[ "$forced_dry" == 1 ]] && live=0
dry_run=1
[[ "$live" == 1 ]] && dry_run=0
# Chain transactions need both flags; anything less prints what they would do.
chain_live=0
[[ "$live" == 1 && "$chain" == 1 ]] && chain_live=1

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

published_values() {
  # published_values <start> <end>: "20261014 $41.23/MWh, ..." for each day
  # of $metric in that range in data/publish-ledger.json, for Telegram.
  "$python_bin" - data/publish-ledger.json "$metric" "$1" "$2" <<'PY'
import json, sys
ledger = json.load(open(sys.argv[1]))
metric, start, end = sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
rows = sorted((int(r["dayKey"]), int(r["value"])) for r in ledger.values()
              if isinstance(r, dict) and r.get("metricId") == metric
              and "value" in r and start <= int(r.get("dayKey", 0)) <= end)
print(", ".join(f"{day} ${value / 100:,.2f}/MWh" for day, value in rows) or "no values in the ledger")
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
  # Outside a live chain run no secret is read at all.
  local name="$1" env_name="$2"
  shift 2
  if [[ "$chain_live" != 1 ]]; then
    "$@"
    return
  fi
  [[ -n "$secret_cmd" ]] || fail "SETTLE_SECRET_CMD is not set; cannot read the $name"
  env "$env_name=/dev/fd/3" "$@" 3< <("$secret_cmd" "$name")
}

chain_step() {
  # chain_step <label> <secret-name> <PASSWORD_ENV> <command...>
  # Runs publish, finalize or resolve; a stop word alerts and stops, any other
  # failure is retried once (each script reads the chain before it sends).
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

mark_changed() {
  # Something was pushed, so the site needs a redeploy. The GitHub deploy
  # job reads these outputs; they are written at once, so a later failure
  # in this run still leaves them set.
  changed=1
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    { echo "changed=1"; echo "sha=$(git rev-parse HEAD)"; } >> "$GITHUB_OUTPUT"
  fi
}

commit_paths() {
  # commit_paths <message> <path...>: commits those paths alone, by pathspec,
  # and pushes. Only live chain steps change them.
  local message="$1"
  shift
  if [[ "$chain_live" != 1 ]]; then
    echo "(dry run) would commit: $message"
    return
  fi
  git add -- "$@"
  if git diff --cached --quiet -- "$@"; then
    echo "Nothing changed in $*; nothing to commit."
    return
  fi
  git commit --quiet -m "$message" -- "$@"
  git push --quiet "$git_remote" "HEAD:refs/heads/$branch_wanted" ||
    fail "push rejected (someone pushed meanwhile); the next run starts from a fresh pull"
  mark_changed
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
if [[ "$dry_run" == 1 ]]; then
  echo "DRY RUN: nothing will be fetched, sent, committed, pushed or deployed."
elif [[ "$chain_live" != 1 ]]; then
  echo "LIVE for the data and the site; the chain steps only print (no --chain)."
else
  echo "LIVE, chain included."
fi
hc_ping /start

# ------------------------------------------------------------------ 1. sync

step "1 sync"
branch="$(git symbolic-ref --quiet --short HEAD || true)"
[[ -n "$branch" ]] || fail "detached HEAD; check out $branch_wanted"
[[ "$branch" != "main" && "$branch_wanted" != "main" ]] || fail "refusing to run on main"
# Switching branches here would change this very file under bash while it
# runs, so the right branch must already be checked out.
[[ "$branch" == "$branch_wanted" ]] ||
  fail "on $branch, not $branch_wanted; check out $branch_wanted first"
if [[ "$dry_run" != 1 ]]; then
  git fetch --quiet "$git_remote"
  git pull --quiet --ff-only "$git_remote" "$branch_wanted"
fi
echo "On $branch at $(git rev-parse --short HEAD)"

# ------------------------------------------------------------------ 2. plan

step "2 plan"
replan

# ------------------------------------------------------------------ 3. fetch

step "3 fetch"
if [[ "$(plan_field fetchNeeded)" == "true" ]]; then
  if [[ "$dry_run" == 1 ]]; then
    echo "(dry run) would run ./refresh_data.sh --requests-lifted --no-build"
  elif ./refresh_data.sh --requests-lifted --no-build; then
    "$python_bin" scripts/validate_metrics.py
    mark_changed
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
  live_args=(--live --yes)
  [[ "$chain_live" == 1 ]] || live_args=()
  REPORTER_KEYSTORE_PATH="${REPORTER_KEYSTORE_PATH:-}" \
    chain_step publish reporter-password REPORTER_KEYSTORE_PASSWORD_FILE \
    "$python_bin" publish.py --metric "$metric" --start "$publish_start" --end "$publish_end" \
    --limit 7 ${live_args[@]+"${live_args[@]}"}
  commit_paths "Ledger: $publish_start-$publish_end HBNORTH reading(s) published on chain" \
    data/publish-ledger.json
  replan
  seconds="$(plan_field secondsToFinalizable)"
  if [[ "$chain_live" == 1 && -n "$seconds" ]]; then
    finalize_at="$(date -u -d "@$(( $(date +%s) + seconds ))" +%H:%MZ 2>/dev/null ||
      date -u -r "$(( $(date +%s) + seconds ))" +%H:%MZ)"
    notify "Published $publish_start-$publish_end: $(published_values "$publish_start" "$publish_end"). Finalizes at about $finalize_at. If a value is wrong, the guardian pauses the oracle and voids it (shared/oracle-v2.md). To stop only this run: gh variable set SETTLE_HOLD --body 1 (or touch $hold_file)."
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
  if [[ "$chain_live" != 1 ]]; then
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
  live_args=(--live --yes)
  [[ "$chain_live" == 1 ]] || live_args=()
  FINALIZER_KEYSTORE_PATH="${SETTLER_KEYSTORE_PATH:-}" \
    chain_step finalize settler-password FINALIZER_KEYSTORE_PASSWORD_FILE \
    "$python_bin" finalize.py --metric "$metric" --start "$finalize_start" --limit 7 \
    ${live_args[@]+"${live_args[@]}"}
  commit_paths "Ledger: HBNORTH reading(s) from $finalize_start finalized on chain" \
    data/publish-ledger.json
  replan
else
  echo "Nothing to finalize."
fi

# ------------------------------------------------------------------ 7. resolve

step "7 resolve"
if [[ -n "$(plan_field resolve)" ]]; then
  live_args=(--live --yes)
  [[ "$chain_live" == 1 ]] || live_args=()
  FINALIZER_KEYSTORE_PATH="${SETTLER_KEYSTORE_PATH:-}" \
    chain_step resolve settler-password FINALIZER_KEYSTORE_PASSWORD_FILE \
    "$python_bin" resolve_markets.py ${live_args[@]+"${live_args[@]}"}
  if [[ "$chain_live" == 1 ]]; then mark_changed; fi
  replan
else
  echo "Nothing to resolve."
fi

# ------------------------------------------------------------------ 8. ladder

step "8 ladder"
if [[ "$(plan_field ladderRunningOut)" == "true" && "${SETTLE_CREATE_MARKETS:-1}" == "1" ]]; then
  ladder_args=()
  [[ "$chain_live" == 1 ]] || ladder_args=(--dry-run)
  rows="$("$python_bin" scripts/extend_ladder.py ${ladder_args[@]+"${ladder_args[@]}"})"
  row_list="$(echo "$rows" | tr '\n' ' ')"
  if [[ -n "$rows" && "$chain_live" != 1 ]]; then
    echo "(dry run) would add and create market rows: $row_list"
  elif [[ -n "$rows" ]]; then
    market_args=()
    for row in $rows; do market_args+=(--market "$row"); done
    # Once, never retried: a create that timed out may still land, and a
    # second attempt would make the same market twice.
    create_out="$log_dir/create-$run_id.out"
    code=0
    FINALIZER_KEYSTORE_PATH="${SETTLER_KEYSTORE_PATH:-}" \
      with_secret settler-password FINALIZER_KEYSTORE_PASSWORD_FILE \
      "$python_bin" create_markets.py "${market_args[@]}" --live --yes \
      > >(tee "$create_out") 2>&1 || code=$?
    sleep 1   # let tee finish writing $create_out
    # Each market is saved to the ledger as it is created: keep what was made.
    commit_paths "Markets: next week's ladder (rows $row_list)" \
      shared/demo-markets.md shared/addresses.json data/market-ledger.json
    if [[ "$code" != 0 ]]; then
      fail "creating markets failed (exit $code) and is not retried; a person must look at logs/create-$run_id.out, then run python create_markets.py --check"
    fi
    notify "Created next week's markets (rows $row_list)."
  else
    echo "No new market days to add."
  fi
else
  echo "Ladder reaches beyond tomorrow."
fi

# ------------------------------------------------------------------ 9. redeploy

step "9 redeploy"
if [[ "$changed" == 1 && "$deploy" == 1 && "$live" == 1 ]]; then
  ./refresh_data.sh --no-fetch
  scripts/check_secrets.sh --build
else
  echo "Nothing to redeploy."
fi

# ------------------------------------------------------------------ 10. verify

step "10 verify"
check=0
"$python_bin" scripts/settle_due.py --check --json "$plan_json" || check=$?
if [[ "$check" != 0 && "$check" != 3 ]]; then
  fail "could not read the chain to verify the run"
fi
if [[ "$chain_live" == 1 ]]; then
  [[ "$check" == 3 ]] && fail "alerts after the run: $(plan_field alerts)"
else
  # The chain steps were off, so any chain work that is due is a person's.
  due=()
  [[ -n "$(plan_field publishStart)" ]] && due+=("publish $(plan_field publishStart)-$(plan_field publishEnd)")
  [[ -n "$(plan_field finalizeStart)" ]] && due+=("finalize from $(plan_field finalizeStart)")
  resolvable="$(plan_field resolve)"
  [[ -n "$resolvable" ]] && due+=("resolve $(echo "$resolvable" | wc -w | tr -d ' ') market(s)")
  [[ "$check" == 3 ]] && echo "Alerts (the chain steps are off): $(plan_field alerts)"
  if (( ${#due[@]} )); then
    message="due on chain, with the chain steps off: $(IFS=';'; echo "${due[*]}")"
    if [[ "$live" == 1 ]]; then
      notify "$message. Run ./daily_settle.sh --live --chain on the laptop."
    else
      echo "$message"
    fi
  fi
fi
echo
if [[ "$chain_live" == 1 || "$check" == 0 ]]; then
  echo "Settle run $run_id finished with no alerts."
else
  echo "Settle run $run_id finished; the chain steps were off, so the alerts above are for a person."
fi
hc_ping ""
