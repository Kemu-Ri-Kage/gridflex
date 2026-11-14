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
# A live run executes only reviewed code (daily-settle spec §14): it needs
# SETTLE_CODE_SHA and SETTLE_CHECKED_HEAD from ops/settle-preflight.sh
# (main's copy), which merged that exact main commit into the data branch,
# proved the code is main's and verify_data.py approved the data. This
# script never fetches or pulls. Before every chain step and every push it
# checks again that HEAD is the checked commit plus its own data commits
# only, and that the code still matches; any difference stops the run.
#
# Spec: docs/specs/2026-10-13-daily-settle.md. Every decision comes from the
# chain at one block plus the committed files (scripts/settle_due.py), never
# from an earlier run, so it is safe to run as often as you like: the main
# run is 00:20 UTC, with catch-up runs at 03:20, 09:20 and 15:20.
#
# Steps:
#   0  lock, and stop if a hold is set
#   1  bind        HEAD must be the commit the preflight checked; never pulls
#   2  plan        scripts/settle_due.py (verified markets only)
#   3  fetch       ./refresh_data.sh --requests-lifted --no-build --no-push,
#                  which validates before it commits; a failed fetch puts the
#                  tree back to the last commit and the run goes on with it
#   4  publish     publish.py --live --yes --day <each planned day>
#   5  wait        out the one-hour dispute window (at most 75 minutes)
#   6  finalize    finalize.py --live --yes --start --end (planned days only),
#                  held if a value is outside -$50..$1,000/MWh
#   7  resolve     resolve_markets.py --live --yes --market <each planned market>
#   8  ladder      when no market day is after tomorrow: add the next week's
#                  rows (scripts/extend_ladder.py) and create exactly those
#                  rows, once: a failed create is never retried
#   9  redeploy    rebuild the site's data from what is committed, commit,
#                  push; a local run with deploy also builds and deploys it
#  10  verify      scripts/settle_due.py --check; with --chain any alert
#                  fails the run; without it, chain work that is due goes to
#                  Telegram for a person to do by hand
#
# Stop words never retry, they alert and stop for a person: see $stop_words.
# Any other failed publish, finalize or resolve is retried once after 120 s
# (each of those reads the chain before it sends, so a retry never repeats a
# transaction).
#
# Secrets never appear on the command line, in the environment of child
# commands that don't need them, or in the logs, and are read only for live
# chain steps. Keystore passwords come from $SETTLE_SECRET_CMD <name>
# (ops/secret-from-env.sh on GitHub) and reach the scripts through a pipe
# (<ROLE>_KEYSTORE_PASSWORD_FILE=/dev/fd/3). Everything printed goes through
# ops/redact.sh; healthchecks gets the step name and exit code only.
#
# Alerts (all optional): TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, and
# HC_PING_URL (healthchecks.io: /start, success, /fail).
#
# To stop a run: create the branch settle-hold (it is read at the start,
# before publishing, after the dispute-window wait, before resolving and
# before creating markets; if it can't be read, that counts as a hold):
#   git push origin HEAD:refs/heads/settle-hold    (remove: git push origin :settle-hold)
# or cancel the run: gh run cancel <run id>. To stop the schedule:
#   gh workflow disable daily-settle
set -Eeuo pipefail

main() {
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
      sed -n '2,74p' "$0"
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
hold_ref="${SETTLE_HOLD_REF:-refs/heads/settle-hold}"
secret_cmd="${SETTLE_SECRET_CMD:-}"
code_sha="${SETTLE_CODE_SHA:-}"
checked_head="${SETTLE_CHECKED_HEAD:-}"
metric="ERCOT_HBNORTH_DA_AVG"
retry_seconds="${SETTLE_RETRY_SECONDS:-120}"
max_wait_seconds="${SETTLE_MAX_WAIT_SECONDS:-4500}"   # 75 minutes
stop_words='may still be in flight|VALUE MISMATCH|differs from immutable|Resolved event says|CORRECTION|still pending|reverted|PROVENANCE|not in the ledger|ORACLE IDENTITY|not the pinned oracle'
# The data paths this run may change; everything else must stay as checked.
data_paths=(data/metrics data/publish-ledger.json data/market-ledger.json web/public/data web/lib/generated
  shared/addresses.json shared/demo-markets.md)
# The address-bearing files only verify_data.py may approve.
verified_paths=(shared/addresses.json shared/demo-markets.md web/public/data/addresses.json)

log_dir="$repo_root/logs"
mkdir -p "$log_dir"
run_id="$(date -u +%Y%m%dT%H%M%SZ)"
run_log="$log_dir/settle-$run_id.log"
plan_json="$log_dir/plan.json"
lock_dir="$repo_root/.settle.lock"
current_step="start"
changed=0
bound_head=""
verified_head=""
new_commit=0

# ------------------------------------------------------------------ alerts

redact() {
  bash "$repo_root/ops/redact.sh"
}

notify() {
  # Telegram, when configured. The token is only ever passed to curl, and
  # the text goes through ops/redact.sh first.
  local text
  text="$(printf '%s' "$1" | redact)"
  echo "$text"
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
    curl -fsS -m 15 -o /dev/null \
      --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=GRIDFLEX settle: ${text}" \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" || true
  fi
}

hc_ping() {
  # healthchecks.io: "" (success), "/start" or "/fail <exit code>". A third
  # party: it gets the step name and exit code, never log text.
  [[ -z "${HC_PING_URL:-}" ]] && return 0
  if [[ "$1" == "/fail" ]]; then
    printf 'step=%s exit=%s\n' "$current_step" "${2:-1}" |
      curl -fsS -m 15 --retry 3 -o /dev/null --data-binary @- "${HC_PING_URL}/fail" || true
  else
    curl -fsS -m 15 --retry 3 -o /dev/null "${HC_PING_URL}$1" || true
  fi
}

fail() {
  if [[ "${BASH_SUBSHELL:-0}" != 0 ]]; then
    # In a subshell: report up, the main shell alerts.
    echo "FAILED: $1" >&2
    exit 1
  fi
  trap - ERR
  notify "FAILED at step '$current_step': $1. Next: run ./daily_settle.sh --dry-run and read logs/settle-$run_id.log."
  hc_ping /fail 1
  exit 1
}

on_error() {
  local code=$?
  [[ "${BASH_SUBSHELL:-0}" == 0 ]] || exit "$code"
  trap - ERR
  notify "FAILED at step '$current_step' (exit $code). See logs/settle-$run_id.log."
  hc_ping /fail "$code"
  exit "$code"
}

cleanup() {
  rmdir "$lock_dir" 2> /dev/null || true
}

# Everything this run prints also goes to its log, redacted.
exec > >(redact | tee -a "$run_log") 2>&1

# ------------------------------------------------------------------ helpers

step() {
  current_step="$1"
  echo
  echo "== [$1] $(date -u +%H:%M:%SZ)"
}

check_hold() {
  # check_hold <where>: stop when a hold is set. The remote ref is read
  # fresh each time; if it can't be read, a live run treats that as a hold.
  local where="$1" code=0
  if [[ "${SETTLE_HOLD:-0}" == "1" && "$where" == "start" ]] || [[ -e "$hold_file" ]]; then
    hold_stop "$where" "a hold is set (SETTLE_HOLD=1 or $hold_file)"
  fi
  git ls-remote --exit-code "$git_remote" "$hold_ref" > /dev/null 2>&1 || code=$?
  case "$code" in
    0) hold_stop "$where" "the hold ref $hold_ref exists" ;;
    2) return 0 ;;
    *)
      if [[ "$dry_run" == 1 ]]; then
        echo "Could not read $hold_ref (exit $code); a dry run goes on."
      else
        hold_stop "$where" "the hold ref $hold_ref could not be read (git exit $code), which counts as a hold"
      fi
      ;;
  esac
}

hold_stop() {
  if [[ "$1" == "start" ]]; then
    echo "Hold: $2; nothing done."
  else
    notify "Hold: $2; stopped before $1."
  fi
  exit 0
}

plan_field() {
  # One field of logs/plan.json as plain text, the way settle_due.py --get
  # prints it (true/false, "" for null, lists as space-separated dayKeys or
  # addresses). A missing file or field exits non-zero: callers fail closed.
  "$python_bin" - "$plan_json" "$1" << 'PY'
import json, sys
plan = json.load(open(sys.argv[1]))
if sys.argv[2] not in plan:
    sys.exit(f"logs/plan.json has no field {sys.argv[2]!r}")
value = plan[sys.argv[2]]
if value is None:
    print("")
elif isinstance(value, bool):
    print("true" if value else "false")
elif isinstance(value, list):
    print(" ".join(str(v.get("dayKey", v.get("market", v))) if isinstance(v, dict) else str(v) for v in value))
else:
    print(value)
PY
}

field() {
  # field <name> <var>: sets <var> to plan_field <name>, or fails the run.
  local value
  value="$(plan_field "$1")" || fail "logs/plan.json is unreadable (field $1); nothing more runs"
  printf -v "$2" '%s' "$value"
}

published_values() {
  # published_values <start> <end>: "20261014 $41.23/MWh, ..." for each day
  # of $metric in that range in data/publish-ledger.json, for Telegram.
  "$python_bin" - data/publish-ledger.json "$metric" "$1" "$2" << 'PY'
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
  rm -f "$plan_json"
  "$python_bin" scripts/settle_due.py --json "$plan_json" || code=$?
  if [[ "$code" == 2 ]]; then
    echo "Plan failed; retrying in ${retry_seconds}s"
    sleep "$retry_seconds"
    code=0
    rm -f "$plan_json"
    "$python_bin" scripts/settle_due.py --json "$plan_json" || code=$?
  fi
  [[ "$code" == 0 || "$code" == 3 ]] || fail "could not read the chain to plan the run"
  [[ -s "$plan_json" ]] || fail "settle_due.py wrote no plan"
}

# ------------------------------------------------------------------ binding (S1)

code_matches() {
  # Main's own copy of the code check, against the reviewed commit.
  git show "$code_sha:ops/code-matches-main.sh" | bash -s -- --allow-verified "$code_sha" > /dev/null
}

assert_bound() {
  # assert_bound <what>: HEAD is the checked commit plus this run's own data
  # commits, the code is main's, the address files are as verified, and
  # nothing outside the data paths changed in the working tree.
  local what="$1" head dirty
  if [[ -z "$code_sha" ]]; then
    [[ "$live" == 1 ]] && fail "a live run needs SETTLE_CODE_SHA from ops/settle-preflight.sh"
    return 0
  fi
  head="$(git rev-parse HEAD)" || fail "cannot read HEAD"
  [[ "$head" == "$bound_head" ]] ||
    fail "HEAD moved to $head, not the checked commit $bound_head, before $what; nothing more runs"
  code_matches || fail "the code no longer matches the reviewed commit $code_sha, before $what"
  git diff --quiet "$verified_head" HEAD -- "${verified_paths[@]}" ||
    fail "the address files changed since verify_data.py approved them, before $what"
  dirty="$(git status --porcelain --untracked-files=all -- . "${data_paths[@]/#/:(exclude)}")"
  [[ -z "$dirty" ]] || fail "files outside the data paths changed in the working tree before $what: $dirty"
}

adopt_commit() {
  # After this run made one commit (a data commit by pathspec): it must sit
  # directly on the bound commit, then it becomes the bound commit.
  local new
  new_commit=0
  new="$(git rev-parse HEAD)"
  [[ "$new" == "$bound_head" ]] && return 0
  [[ "$(git rev-list --parents -n 1 "$new")" == "$new $bound_head" ]] ||
    fail "commit $new is not one commit on top of $bound_head"
  bound_head="$new"
  new_commit=1
  assert_bound "adopting $new"
}

push_bound() {
  # Push exactly the bound commit. A rejected push is a failure, never a pull.
  assert_bound "push"
  git push --quiet "$git_remote" "$bound_head:refs/heads/$branch_wanted" ||
    fail "push rejected (someone pushed meanwhile); nothing was pulled. The next scheduled run starts from a fresh checkout"
  mark_changed
}

restore_tree() {
  # Back to the bound commit: drop whatever a failed or dry step left in the
  # data paths (data/raw is ignored and kept).
  if [[ -n "$bound_head" ]]; then
    git reset --quiet --hard "$bound_head"
  else
    git checkout --quiet -- data web/public/data web/lib/generated 2> /dev/null || true
  fi
  git clean -fdq -- data/metrics web/public/data web/lib/generated
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
  env "$env_name=/dev/fd/3" "$@" 3< <("$secret_cmd" "$name")
}

chain_step() {
  # chain_step <label> <secret-name> <PASSWORD_ENV> <command...>
  # Runs publish, finalize or resolve; a stop word alerts and stops, any other
  # failure is retried once (each script reads the chain before it sends).
  local label="$1" secret="$2" env_name="$3"
  shift 3
  local out="$log_dir/$label-$run_id.out" code attempt
  for attempt in 1 2; do
    assert_bound "$label"
    code=0
    # Synchronous: tee has written all of $out when the pipeline returns.
    { with_secret "$secret" "$env_name" "$@" 2>&1 | redact | tee "$out"; } || code=$?
    if grep -Eq "$stop_words" "$out"; then
      fail "$label hit a stop word ($(grep -Eo "$stop_words" "$out" | head -1)); a person must look"
    fi
    if [[ "$chain_live" != 1 ]]; then
      # A dry chain step may rewrite a ledger from chain reads; the run
      # keeps to what is committed.
      git checkout --quiet -- data/publish-ledger.json data/market-ledger.json 2> /dev/null || true
    fi
    [[ "$code" == 0 ]] && return 0
    if [[ "$attempt" == 1 ]]; then
      echo "$label failed (exit $code); retrying in ${retry_seconds}s"
      sleep "$retry_seconds"
    fi
  done
  fail "$label failed twice (exit $code)"
}

mark_changed() {
  # Something was pushed, so the site needs a redeploy. The GitHub deploy
  # job reads these outputs (the last sha= wins); they are written at once,
  # so a later failure in this run still leaves them set.
  changed=1
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    { echo "changed=1"; echo "sha=$bound_head"; } >> "$GITHUB_OUTPUT"
  fi
}

commit_paths() {
  # commit_paths [--reverify] <message> <path...>: commits those paths alone,
  # by pathspec, and pushes. Only live chain steps change them. --reverify
  # runs verify_data.py again first (the ladder changes the address files).
  local reverify=0
  if [[ "$1" == "--reverify" ]]; then
    reverify=1
    shift
  fi
  local message="$1"
  shift
  if [[ "$chain_live" != 1 ]]; then
    echo "(dry run) would commit: $message"
    return
  fi
  assert_bound "commit"
  git add -- "$@"
  if git diff --cached --quiet -- "$@"; then
    echo "Nothing changed in $*; nothing to commit."
    return
  fi
  git commit --quiet -m "$message" -- "$@" || fail "git commit failed: $message"
  local new
  new="$(git rev-parse HEAD)"
  [[ "$(git rev-list --parents -n 1 "$new")" == "$new $bound_head" ]] ||
    fail "commit $new is not one commit on top of $bound_head"
  bound_head="$new"
  if [[ "$reverify" == 1 ]]; then
    "$python_bin" scripts/verify_data.py --base "$code_sha" ||
      fail "verify_data.py refused the markets this run created; they are committed locally, not pushed"
    verified_head="$bound_head"
  fi
  push_bound
}

# ------------------------------------------------------------------ 0. lock and hold

if ! mkdir "$lock_dir" 2> /dev/null; then
  echo "Another settle run holds $lock_dir; exiting."
  exit 0
fi
trap cleanup EXIT
trap on_error ERR

step "0 hold"
check_hold start
if [[ "$dry_run" == 1 ]]; then
  echo "DRY RUN: nothing will be fetched, sent, committed, pushed or deployed."
elif [[ "$chain_live" != 1 ]]; then
  echo "LIVE for the data and the site; the chain steps only print (no --chain)."
else
  echo "LIVE, chain included."
fi
hc_ping /start

# ------------------------------------------------------------------ 1. bind

step "1 bind"
branch="$(git symbolic-ref --quiet --short HEAD || true)"
[[ -n "$branch" ]] || fail "detached HEAD; check out $branch_wanted"
[[ "$branch" != "main" && "$branch_wanted" != "main" ]] || fail "refusing to run on main"
# Switching branches here would change this very file under bash while it
# runs, so the right branch must already be checked out.
[[ "$branch" == "$branch_wanted" ]] ||
  fail "on $branch, not $branch_wanted; check out $branch_wanted first"
if [[ -n "$code_sha" ]]; then
  [[ "$code_sha" =~ ^[0-9a-f]{40}$ ]] || fail "SETTLE_CODE_SHA must be a full commit SHA"
  [[ -n "$checked_head" ]] || fail "SETTLE_CHECKED_HEAD is not set; run ops/settle-preflight.sh"
  [[ "$(git rev-parse HEAD)" == "$checked_head" ]] ||
    fail "HEAD $(git rev-parse HEAD) is not the commit the preflight checked ($checked_head)"
  git merge-base --is-ancestor "$code_sha" HEAD || fail "HEAD does not contain the reviewed commit $code_sha"
  bound_head="$checked_head"
  verified_head="$checked_head"
  assert_bound "the run"
  echo "On $branch at ${bound_head:0:7}, running the code of ${code_sha:0:7}; never pulled."
elif [[ "$live" == 1 ]]; then
  fail "a live run needs SETTLE_CODE_SHA and SETTLE_CHECKED_HEAD from ops/settle-preflight.sh; nothing was run"
else
  bound_head="$(git rev-parse HEAD)"
  echo "On $branch at ${bound_head:0:7} (dry run, not bound to a reviewed commit)"
fi
if [[ "$chain_live" == 1 && -z "$secret_cmd" ]]; then
  fail "SETTLE_SECRET_CMD is not set; a chain run cannot read its keys"
fi

# ------------------------------------------------------------------ 2. plan

step "2 plan"
replan
# Only the pinned GridOracleV2, proven by bytecode and roles, gets a
# transaction (daily-settle spec §13.2, §14).
if [[ "$chain_live" == 1 ]]; then
  field oracleVerified verified
  [[ "$verified" == "true" ]] ||
    fail "the oracle is not the verified GridOracleV2 pinned in shared/pins.json, so the job sends it nothing ($(plan_field oracleIdentity || true))"
  field unverifiedMarkets unverified
  [[ -z "$unverified" ]] || fail "the ledger lists markets that failed verification: $unverified"
fi

# ------------------------------------------------------------------ 3. fetch

step "3 fetch"
field fetchNeeded fetch_needed
if [[ "$fetch_needed" == "true" ]]; then
  if [[ "$dry_run" == 1 ]]; then
    echo "(dry run) would run ./refresh_data.sh --requests-lifted --no-build --no-push"
  else
    assert_bound "fetch"
    if ./refresh_data.sh --requests-lifted --no-build --no-push; then
      adopt_commit
      if [[ "$new_commit" == 1 ]]; then push_bound; fi
      replan
    else
      # No retry inside a run: the GridStatus budget is metered. Nothing
      # fetched was committed; go on with what is.
      restore_tree
      assert_bound "after the failed fetch"
      notify "Fetch or validation failed; nothing fetched was committed. Going on with the committed data."
      replan
    fi
  fi
else
  echo "Nothing to fetch."
fi

# ------------------------------------------------------------------ 4. publish

step "4 publish"
field publishStart publish_start
field publishEnd publish_end
field publish publish_days
if [[ -n "$publish_start" ]]; then
  [[ "$chain_live" == 1 ]] && check_hold "publishing"
  live_args=(--live --yes)
  [[ "$chain_live" == 1 ]] || live_args=()
  day_args=()
  for day in $publish_days; do day_args+=(--day "$day"); done
  REPORTER_KEYSTORE_PATH="${REPORTER_KEYSTORE_PATH:-}" \
    chain_step publish reporter-password REPORTER_KEYSTORE_PASSWORD_FILE \
    "$python_bin" publish.py --metric "$metric" --start "$publish_start" --end "$publish_end" \
    ${day_args[@]+"${day_args[@]}"} --limit 7 ${live_args[@]+"${live_args[@]}"}
  commit_paths "Ledger: $publish_start-$publish_end HBNORTH reading(s) published on chain" \
    data/publish-ledger.json
  replan
  field secondsToFinalizable seconds
  if [[ "$chain_live" == 1 && -n "$seconds" ]]; then
    finalize_at="$(date -u -d "@$(($(date +%s) + seconds))" +%H:%MZ 2> /dev/null ||
      date -u -r "$(($(date +%s) + seconds))" +%H:%MZ)"
    notify "Published $publish_start-$publish_end: $(published_values "$publish_start" "$publish_end"). Finalizes at about $finalize_at. If a value is wrong, the guardian pauses the oracle and voids it (shared/oracle-v2.md). To stop this run before it finalizes: git push origin HEAD:refs/heads/settle-hold, or gh run cancel ${GITHUB_RUN_ID:-<run id>}."
  fi
else
  echo "Nothing to publish."
fi

# ------------------------------------------------------------------ 5. wait

step "5 wait"
field secondsToFinalizable seconds
if [[ -n "$seconds" && "$seconds" -gt 0 ]]; then
  wait_for=$((seconds + 90))
  ((wait_for > max_wait_seconds)) && wait_for=$max_wait_seconds
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

# ------------------------------------------------------------------ 6. finalize

step "6 finalize"
field finalizeStart finalize_start
field finalize finalize_days
if [[ -n "$finalize_start" ]]; then
  [[ "$chain_live" == 1 ]] && check_hold "finalizing"
  field outOfRange out_of_range
  if [[ -n "$out_of_range" ]]; then
    fail "a published value is outside -\$50..\$1,000/MWh ($out_of_range); finalizing held for a person"
  fi
  finalize_end="${finalize_days##* }"
  live_args=(--live --yes)
  [[ "$chain_live" == 1 ]] || live_args=()
  FINALIZER_KEYSTORE_PATH="${SETTLER_KEYSTORE_PATH:-}" \
    chain_step finalize settler-password FINALIZER_KEYSTORE_PASSWORD_FILE \
    "$python_bin" finalize.py --metric "$metric" --start "$finalize_start" --end "$finalize_end" --limit 7 \
    ${live_args[@]+"${live_args[@]}"}
  commit_paths "Ledger: HBNORTH reading(s) $finalize_start-$finalize_end finalized on chain" \
    data/publish-ledger.json
  replan
else
  echo "Nothing to finalize."
fi

# ------------------------------------------------------------------ 7. resolve

step "7 resolve"
field resolve resolvable
if [[ -n "$resolvable" ]]; then
  [[ "$chain_live" == 1 ]] && check_hold "resolving"
  live_args=(--live --yes)
  [[ "$chain_live" == 1 ]] || live_args=()
  market_args=()
  for address in $resolvable; do
    [[ "$address" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "the plan's resolve list holds '$address', not an address"
    market_args+=(--market "$address")
  done
  FINALIZER_KEYSTORE_PATH="${SETTLER_KEYSTORE_PATH:-}" \
    chain_step resolve settler-password FINALIZER_KEYSTORE_PASSWORD_FILE \
    "$python_bin" resolve_markets.py ${market_args[@]+"${market_args[@]}"} ${live_args[@]+"${live_args[@]}"}
  if [[ "$chain_live" == 1 ]]; then mark_changed; fi
  replan
else
  echo "Nothing to resolve."
fi

# ------------------------------------------------------------------ 8. ladder

step "8 ladder"
field ladderRunningOut ladder_short
if [[ "$ladder_short" == "true" && "${SETTLE_CREATE_MARKETS:-1}" == "1" ]]; then
  ladder_args=()
  [[ "$chain_live" == 1 ]] || ladder_args=(--dry-run)
  [[ "$chain_live" == 1 ]] && check_hold "creating markets"
  [[ "$chain_live" == 1 ]] && assert_bound "the ladder"
  rows="$("$python_bin" scripts/extend_ladder.py ${ladder_args[@]+"${ladder_args[@]}"})" ||
    fail "scripts/extend_ladder.py failed"
  row_list="$(echo "$rows" | tr '\n' ' ')"
  if [[ -n "$rows" && "$chain_live" != 1 ]]; then
    echo "(dry run) would add and create market rows: $row_list"
  elif [[ -n "$rows" ]]; then
    # Only the rows extend_ladder added in this run: new numbers, not in the
    # committed table, now in the working copy.
    committed_rows="$(git show "$bound_head:shared/demo-markets.md" | grep -Eo '^\| *[0-9]+ *\|' | tr -dc '0-9\n' || true)"
    market_args=()
    count=0
    for row in $rows; do
      [[ "$row" =~ ^[0-9]+$ ]] || fail "extend_ladder printed '$row', not a row number"
      grep -qx "$row" <<< "$committed_rows" && fail "row $row was already in the committed table; refusing to create it"
      grep -Eq "^\| *$row *\|" shared/demo-markets.md || fail "row $row is not in shared/demo-markets.md"
      market_args+=(--market "$row")
      count=$((count + 1))
    done
    ((count <= 21)) || fail "extend_ladder added $count rows; at most 21 (a week) are created unattended"
    # Once, never retried: a create that timed out may still land, and a
    # second attempt would make the same market twice.
    create_out="$log_dir/create-$run_id.out"
    code=0
    { FINALIZER_KEYSTORE_PATH="${SETTLER_KEYSTORE_PATH:-}" \
      with_secret settler-password FINALIZER_KEYSTORE_PASSWORD_FILE \
      "$python_bin" create_markets.py ${market_args[@]+"${market_args[@]}"} --live --yes 2>&1 | redact | tee "$create_out"; } || code=$?
    # Each market is saved to the ledger as it is created: keep what was made.
    commit_paths --reverify "Markets: next week's ladder (rows $row_list)" \
      shared/demo-markets.md shared/addresses.json data/market-ledger.json
    if grep -Eq "$stop_words" "$create_out"; then
      fail "creating markets hit a stop word ($(grep -Eo "$stop_words" "$create_out" | head -1)); a person must look at logs/create-$run_id.out"
    fi
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
if [[ "$changed" == 1 && "$live" == 1 ]]; then
  # The site's data, rebuilt from what is committed, committed and pushed:
  # the deploy job then builds exactly the pushed commit.
  assert_bound "rebuilding the site data"
  ./refresh_data.sh --no-fetch --no-build --no-push || fail "rebuilding the site data failed"
  adopt_commit
  if [[ "$new_commit" == 1 ]]; then push_bound; fi
  if [[ "$deploy" == 1 ]]; then
    assert_bound "the deploy"
    ./refresh_data.sh --no-fetch --no-commit
    scripts/check_secrets.sh --build
  fi
else
  echo "Nothing to redeploy."
fi

# ------------------------------------------------------------------ 10. verify

step "10 verify"
check=0
rm -f "$plan_json"
"$python_bin" scripts/settle_due.py --check --json "$plan_json" || check=$?
if [[ "$check" != 0 && "$check" != 3 ]]; then
  fail "could not read the chain to verify the run"
fi
if [[ "$chain_live" == 1 ]]; then
  if [[ "$check" == 3 ]]; then
    field alerts alerts
    fail "alerts after the run: $alerts"
  fi
else
  # The chain steps were off, so any chain work that is due is a person's.
  due=()
  field publishStart publish_start
  field publishEnd publish_end
  field finalizeStart finalize_start
  field resolve resolvable
  field alerts alerts
  [[ -n "$publish_start" ]] && due+=("publish $publish_start-$publish_end")
  [[ -n "$finalize_start" ]] && due+=("finalize from $finalize_start")
  [[ -n "$resolvable" ]] && due+=("resolve $(echo "$resolvable" | wc -w | tr -d ' ') market(s)")
  [[ "$check" == 3 ]] && echo "Alerts (the chain steps are off): $alerts"
  if ((${#due[@]})); then
    message="due on chain, with the chain steps off: $(
      IFS=';'
      echo "${due[*]}"
    )"
    if [[ "$live" == 1 ]]; then
      notify "$message. Stage B is off; a person must do this by hand."
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
}

main "$@"
exit $?
