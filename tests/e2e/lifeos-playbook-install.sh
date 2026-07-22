#!/usr/bin/env bash
# LifeOS claude-playbook — LIFECYCLE E2E suite (install / deploy / update / delete).
#
# Drives `claude-playbook` and `bin/deploy.ts` through real herdr terminal panes,
# exactly as a user would, and asserts the playbook PACKAGING invariants only:
# install produces a self-contained config root, the deployer is a clean
# idempotent create-only overlay, git-tracked state stays pristine (only the
# CLI-owned `.playbook` is ever modified), the update script fast-forwards +
# redeploys and guards a dirty tree, and delete removes both the install dir and
# its alias.
#
# OUT OF SCOPE (owned by the runtime-artifact sibling suite): settings.json
# content assertions, hook smoke tests, path-rewrite correctness sweeps. This
# suite only checks the minimal "deploy exited 0 and created settings.json +
# runtime/" that its lifecycle steps depend on, plus the --full tier's
# statusLine/spinner PACKAGING keys.
#
# Philosophy: assert packaging invariants; upstream LifeOS internals/quirks are
# intentionally left as-is and never asserted against.
#
# SANDBOX (absolute): every path lives under one `mktemp -d` run root. Each pane
# case exports HOME, CLAUDE_PLAYBOOKS_DIR, CLAUDE_SHELL_CONFIG into the run root
# before any cpb/deploy command, so the suite never reads or writes the caller's
# real ~/.claude-playbooks, ~/.zshrc, or ~/.claude. It is safe for anyone to run.
#
# Must run from inside herdr (HERDR_ENV=1): a dedicated workspace
# `lifeos-e2e-install` is created and its panes are split from the caller's own
# pane ($HERDR_PANE_ID), never from --current. Case completion is detected via an
# rc file written by the pane shell (robust against narrow-pane line wrapping);
# the pane screen is snapshotted to a per-case log for debugging.
#
# Keep-going: a failing case is recorded and the run CONTINUES (so a product bug
# surfaces as one FAIL, not an aborted suite). The suite exits non-zero iff any
# case failed.
#
# Debug: LP_E2E_KEEP_PANES=1 keeps the workspace/panes; LP_E2E_KEEP_TMP=1 keeps
# the run root. Both are kept automatically on any failure.

set -euo pipefail

TMP_ROOT="${TMPDIR:-/tmp}"
TMP_ROOT="${TMP_ROOT%/}"
KEEP_PANES="${LP_E2E_KEEP_PANES:-0}"
KEEP_TMP="${LP_E2E_KEEP_TMP:-0}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}
need herdr
need git
need bun
need claude-playbook
need python3
need shasum

BASE_PANE="${HERDR_PANE_ID:-}"
if [ -z "$BASE_PANE" ]; then
  echo "HERDR_PANE_ID is not set. Run this suite from inside a herdr pane." >&2
  exit 1
fi

# ── source of truth: install the branch this suite lives on, from the primary
#    checkout that owns the shared object store (overridable for portability). ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GIT_COMMON="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
PRIMARY_CHECKOUT="$(cd "$(dirname "${GIT_COMMON:-$REPO_ROOT/.git}")" && pwd)"
SOURCE_URL="${LP_E2E_SOURCE:-file://$PRIMARY_CHECKOUT}"
BRANCH="${LP_E2E_BRANCH:-$(git -C "$REPO_ROOT" branch --show-current)}"
CPB_BIN="$(command -v claude-playbook)"

RUN_ROOT="$(mktemp -d "$TMP_ROOT/lifeos-lifecycle-e2e.XXXXXX")"
HOME_DIR="$RUN_ROOT/home"
PLAYBOOKS_DIR="$RUN_ROOT/playbooks"
SHELL_CONFIG="$RUN_ROOT/zshrc"
COMMAND_DIR="$RUN_ROOT/commands"
LOG_DIR="$RUN_ROOT/logs"
ENV_FILE="$RUN_ROOT/env.sh"
mkdir -p "$HOME_DIR" "$PLAYBOOKS_DIR" "$COMMAND_DIR" "$LOG_DIR"
: > "$SHELL_CONFIG"

WS_ID=""
PANES=""
declare -a RESULTS=()
FAILED=0

cleanup() {
  rc=$?
  if [ "$KEEP_PANES" != "1" ] && [ $rc -eq 0 ]; then
    if [ -n "$WS_ID" ]; then
      herdr workspace close "$WS_ID" >/dev/null 2>&1 || true
    fi
    for pane in $PANES; do
      herdr pane close "$pane" >/dev/null 2>&1 || true
    done
  else
    echo "herdr workspace kept: ${WS_ID:-none} (panes: $PANES)"
  fi
  if [ "$KEEP_TMP" != "1" ] && [ $rc -eq 0 ]; then
    rm -rf "$RUN_ROOT"
  else
    echo "E2E artifacts kept at: $RUN_ROOT"
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

# ── env baked into every pane case (absolute paths via %q; cpb() helper pins
#    the sandbox flags; PATH is baked so panes find bun/claude-playbook/git). ──
write_env_file() {
  cat > "$ENV_FILE" <<EOF
export LP_E2E_RUN_ROOT=$(printf '%q' "$RUN_ROOT")
export LP_E2E_ENV=$(printf '%q' "$ENV_FILE")
export HOME=$(printf '%q' "$HOME_DIR")
export CLAUDE_PLAYBOOKS_DIR=$(printf '%q' "$PLAYBOOKS_DIR")
export CLAUDE_SHELL_CONFIG=$(printf '%q' "$SHELL_CONFIG")
export PATH=$(printf '%q' "$PATH")
export CPB=$(printf '%q' "$CPB_BIN")
export LP_SOURCE=$(printf '%q' "$SOURCE_URL")
export LP_BRANCH=$(printf '%q' "$BRANCH")
export LP_NAME=lifeos
export LP_ALIAS=lifeos
export LP_INSTALL=$(printf '%q' "$PLAYBOOKS_DIR/lifeos")
cpb() { "\$CPB" --playbooks-dir "\$CLAUDE_PLAYBOOKS_DIR" --shell-config "\$CLAUDE_SHELL_CONFIG" "\$@"; }
EOF
}

# ── herdr helpers ──────────────────────────────────────────────────────
pane_id_from_split() {
  python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])'
}

setup_workspace() {
  # Split from the caller's own pane, then move that pane into a dedicated
  # workspace so the run does not crowd the caller's tab.
  local first move_json
  first="$(herdr pane split "$BASE_PANE" --direction right --no-focus 2>/dev/null | pane_id_from_split)"
  [ -n "$first" ] || { echo "Could not split base pane" >&2; exit 1; }
  move_json="$(herdr pane move "$first" --new-workspace --label lifeos-e2e-install --no-focus 2>/dev/null || true)"
  WS_ID="$(printf '%s' "$move_json" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["result"]["move_result"]["created_workspace"]["workspace_id"])
except Exception: print("")')"
  local moved
  moved="$(printf '%s' "$move_json" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["result"]["move_result"]["pane"]["pane_id"])
except Exception: print("")')"
  [ -n "$moved" ] && first="$moved"
  P_MAIN="$first"
  P_AUX="$(herdr pane split "$P_MAIN" --direction down --no-focus 2>/dev/null | pane_id_from_split)"
  [ -n "$P_AUX" ] || { echo "Could not split aux pane" >&2; exit 1; }
  PANES="$P_MAIN $P_AUX"
  herdr pane rename "$P_MAIN" lp-main >/dev/null 2>&1 || true
  herdr pane rename "$P_AUX" lp-aux >/dev/null 2>&1 || true
}

write_case() {
  local name="$1" file
  file="$COMMAND_DIR/$1.sh"
  cat > "$file"
  chmod +x "$file"
  printf '%s\n' "$file"
}

start_case() {
  local pane="$1" name="$2" file="$3" marker rc_file line
  marker="__LP_E2E_DONE_${name}_$RANDOM"
  printf '%s\n' "$marker" > "$COMMAND_DIR/$name.marker"
  rc_file="$COMMAND_DIR/$name.rc"
  rm -f "$rc_file"
  # rc file is the completion signal (screen text wraps in narrow panes); tee
  # keeps the marker visible in the pane for the operator. LP_E2E_ENV is injected
  # on the command line so the case can bootstrap by sourcing env.sh (env.sh
  # itself is what DEFINES the rest of the sandbox env).
  line="LP_E2E_ENV=$(printf '%q' "$ENV_FILE") bash $(printf '%q' "$file"); __lp_rc=\$?; echo $marker:\$__lp_rc | tee $(printf '%q' "$rc_file")"
  herdr pane send-text "$pane" "$line" >/dev/null
  herdr pane send-keys "$pane" Enter >/dev/null
}

wait_case() {
  local pane="$1" name="$2" marker rc_file log deadline rc
  marker="$(cat "$COMMAND_DIR/$name.marker")"
  rc_file="$COMMAND_DIR/$name.rc"
  log="$LOG_DIR/$name.log"
  deadline=$((SECONDS + 300))
  while [ "$SECONDS" -lt "$deadline" ]; do
    herdr pane read "$pane" --source visible --lines 200 --format text > "$log" 2>/dev/null || true
    if [ -f "$rc_file" ]; then
      rc="$(sed -n "s/^$marker:\([0-9][0-9]*\)$/\1/p" "$rc_file" | tail -1)"
      if [ -n "$rc" ]; then
        [ "$rc" -eq 0 ] && return 0
        echo "  ---- $name log tail ----" >&2
        tail -40 "$log" >&2
        return "$rc"
      fi
    fi
    sleep 0.5
  done
  echo "TIMEOUT $name. Log: $log" >&2
  tail -40 "$log" >&2
  return 124
}

# Runs a case and RECORDS the outcome without aborting the suite (keep-going).
run_case() {
  local pane="$1" name="$2" file="$3"
  echo "RUN  $name on $pane"
  start_case "$pane" "$name" "$file"
  if wait_case "$pane" "$name"; then
    echo "PASS $name"
    RESULTS+=("PASS|$name")
  else
    echo "FAIL $name (log: $LOG_DIR/$name.log)" >&2
    RESULTS+=("FAIL|$name")
    FAILED=1
  fi
}

# ── build ──────────────────────────────────────────────────────────────
write_env_file
setup_workspace

# 01 install ------------------------------------------------------------------
c01="$(write_case 01_install <<'CASE'
set -euo pipefail
source "$LP_E2E_ENV"
out="$(cpb install "$LP_SOURCE" --branch "$LP_BRANCH" --name "$LP_NAME" --alias "$LP_ALIAS" 2>&1)"
printf '%s\n' "$out"
grep -q "Installed \"$LP_NAME\"" <<<"$out"
# A packaged playbook must ship a CLAUDE.md — the CLI warns loudly otherwise.
if grep -q 'has no CLAUDE.md' <<<"$out"; then echo "FAIL: CLI emitted 'has no CLAUDE.md'" >&2; exit 1; fi
# Config root is self-contained.
test -f "$LP_INSTALL/.playbook"
test -f "$LP_INSTALL/CLAUDE.md"
test -d "$LP_INSTALL/bin"
test -d "$LP_INSTALL/LifeOS"
# Cloned at the requested branch.
test "$(git -C "$LP_INSTALL" rev-parse --abbrev-ref HEAD)" = "$LP_BRANCH"
# Alias line points CLAUDE_CONFIG_DIR at the install dir.
alias_line="$(grep '^alias lifeos=' "$CLAUDE_SHELL_CONFIG")"
grep -q "CLAUDE_CONFIG_DIR=\"$LP_INSTALL\"" <<<"$alias_line"
# `list` reports the playbook.
list_out="$(cpb list 2>&1)"
grep -Eq '^lifeos[[:space:]]' <<<"$list_out"
echo "OK 01_install"
CASE
)"

# 02 manifest -----------------------------------------------------------------
c02="$(write_case 02_manifest <<'CASE'
set -euo pipefail
source "$LP_E2E_ENV"
pb="$LP_INSTALL/.playbook"
test -f "$pb"
shipped="$(git -C "$LP_INSTALL" show HEAD:.playbook)"   # committed manifest as shipped
installed="$(cat "$pb")"
# version / name / alias preserved verbatim from the shipped manifest.
for key in version name alias; do
  s="$(grep "^$key = " <<<"$shipped" || true)"
  i="$(grep "^$key = " <<<"$installed" || true)"
  test -n "$s"
  test "$s" = "$i"
done
# update_script preserved.
grep -q '^update_script = "bin/update-playbook.sh"' <<<"$installed"
grep -q '^update_script = ' <<<"$shipped"
# [source] present; CLI injected branch (shipped manifest had none) + repository.
grep -q '^\[source\]' <<<"$installed"
grep -q "^branch = \"$LP_BRANCH\"" <<<"$installed"
if grep -q '^branch = ' <<<"$shipped"; then echo "FAIL: shipped manifest already had a branch" >&2; exit 1; fi
grep -q '^repository = ' <<<"$installed"
echo "OK 02_manifest"
CASE
)"

# 03 deploy dry-run -----------------------------------------------------------
c03="$(write_case 03_deploy_dryrun <<'CASE'
set -euo pipefail
source "$LP_E2E_ENV"
cd "$LP_INSTALL"
before_status="$(git status --porcelain)"
before_count="$(find "$LP_INSTALL" -not -path '*/.git/*' | wc -l | tr -d ' ')"
out="$(bun bin/deploy.ts 2>&1)"
grep -q 'DRY-RUN' <<<"$out"
grep -q 'Dry-run complete' <<<"$out"
after_status="$(git status --porcelain)"
after_count="$(find "$LP_INSTALL" -not -path '*/.git/*' | wc -l | tr -d ' ')"
# A dry-run must write nothing: tracked state and file count are unchanged.
test "$before_status" = "$after_status"
test "$before_count" = "$after_count"
test ! -e "$LP_INSTALL/settings.json"
echo "OK 03_deploy_dryrun (files=$before_count)"
CASE
)"

# 04 deploy apply -------------------------------------------------------------
c04="$(write_case 04_deploy_apply <<'CASE'
set -euo pipefail
source "$LP_E2E_ENV"
cd "$LP_INSTALL"
out="$(bun bin/deploy.ts --apply 2>&1)"
grep -q 'Deploy complete' <<<"$out"
test -f "$LP_INSTALL/settings.json"
test -d "$LP_INSTALL/runtime/LIFEOS"
test -d "$LP_INSTALL/skills"
test -d "$LP_INSTALL/hooks"
test -d "$LP_INSTALL/USER"
# Baseline settings.json hash for the idempotency / create-only / update cases.
shasum -a 256 "$LP_INSTALL/settings.json" | awk '{print $1}' > "$LP_E2E_RUN_ROOT/settings-baseline.hash"
echo "OK 04_deploy_apply"
CASE
)"

# 05 gitignore integrity ------------------------------------------------------
c05="$(write_case 05_gitignore <<'CASE'
set -euo pipefail
source "$LP_E2E_ENV"
cd "$LP_INSTALL"
status="$(git status --porcelain)"
# The entire deployed runtime is gitignored; the ONLY tracked change is the
# CLI-owned manifest. Anything else means a gitignore gap.
if [ "$status" != " M .playbook" ]; then
  echo "FAIL: post-deploy git status is not exactly ' M .playbook':" >&2
  printf '%s\n' "$status" >&2
  exit 1
fi
echo "OK 05_gitignore"
CASE
)"

# 06 idempotency --------------------------------------------------------------
c06="$(write_case 06_idempotency <<'CASE'
set -euo pipefail
source "$LP_E2E_ENV"
cd "$LP_INSTALL"
baseline="$(cat "$LP_E2E_RUN_ROOT/settings-baseline.hash")"
out="$(bun bin/deploy.ts --apply 2>&1)"
grep -q 'Deploy complete' <<<"$out"
now="$(shasum -a 256 settings.json | awk '{print $1}')"
test "$baseline" = "$now"
grep -q 'left untouched' <<<"$out"
# Second apply copies nothing.
if grep -qE 'copied [1-9][0-9]* file' <<<"$out"; then
  echo "FAIL: second --apply copied files (not idempotent)" >&2
  grep -E 'copied [1-9][0-9]* file' <<<"$out" >&2
  exit 1
fi
echo "OK 06_idempotency"
CASE
)"

# 07 full tier: create-only on an EXISTING install ----------------------------
c07="$(write_case 07_full_create_only <<'CASE'
set -euo pipefail
source "$LP_E2E_ENV"
cd "$LP_INSTALL"
baseline="$(cat "$LP_E2E_RUN_ROOT/settings-baseline.hash")"
out="$(bun bin/deploy.ts --apply --full 2>&1)"
grep -q 'left untouched' <<<"$out"
now="$(shasum -a 256 settings.json | awk '{print $1}')"
# settings.json is create-only: --full must NOT rewrite an existing (core) file.
test "$baseline" = "$now"
if grep -q '"statusLine"' settings.json; then
  echo "FAIL: --full mutated an existing settings.json (statusLine appeared)" >&2
  exit 1
fi
test "$(git status --porcelain)" = " M .playbook"
echo "OK 07_full_create_only"
CASE
)"

# 07b full tier: FRESH install gets statusLine + spinner ----------------------
c07b="$(write_case 07b_full_fresh <<'CASE'
set -euo pipefail
source "$LP_E2E_ENV"
# Fully isolated: separate playbooks dir + shell config so this never perturbs
# the main lifecycle zshrc/install.
pbfull="$LP_E2E_RUN_ROOT/playbooks-full"
scfull="$LP_E2E_RUN_ROOT/zshrc-full"
mkdir -p "$pbfull"; : > "$scfull"
"$CPB" --playbooks-dir "$pbfull" --shell-config "$scfull" \
  install "$LP_SOURCE" --branch "$LP_BRANCH" --name lifeosfull --alias lifeosfull >/dev/null 2>&1
inst="$pbfull/lifeosfull"
test -d "$inst"
cd "$inst"
out="$(bun bin/deploy.ts --apply --full 2>&1)"
grep -q 'Deploy complete' <<<"$out"
test -f "$inst/settings.json"
# --full on a FRESH create wires the enhancement keys.
grep -q '"statusLine"' settings.json
grep -q '"spinnerVerbs"' settings.json
test "$(git status --porcelain)" = " M .playbook"
echo "OK 07b_full_fresh"
CASE
)"

# 08 update happy path --------------------------------------------------------
c08="$(write_case 08_update_happy <<'CASE'
set -euo pipefail
source "$LP_E2E_ENV"
cd "$LP_INSTALL"
baseline="$(cat "$LP_E2E_RUN_ROOT/settings-baseline.hash")"
out="$(cpb update lifeos 2>&1)"
printf '%s\n' "$out"
# ff-only pull + idempotent redeploy.
grep -qi 'fast-forward only' <<<"$out"
grep -qi 're-deploying' <<<"$out"
grep -q 'Deploy complete' <<<"$out"
# Existing settings.json content is preserved across an update.
now="$(shasum -a 256 settings.json | awk '{print $1}')"
test "$baseline" = "$now"
echo "OK 08_update_happy"
CASE
)"

# 09 update dirty guard -------------------------------------------------------
c09="$(write_case 09_update_dirty_guard <<'CASE'
set -euo pipefail
source "$LP_E2E_ENV"
cd "$LP_INSTALL"
printf '\nLP_E2E_DIRTY_MARKER\n' >> README.md
set +e
out="$(cpb update lifeos 2>&1)"
rc=$?
set -e
test "$rc" -ne 0
grep -qi 'tracked files are modified' <<<"$out"
# Restore and confirm the guard clears.
git checkout -- README.md
test "$(git status --porcelain)" = " M .playbook"
out2="$(cpb update lifeos 2>&1)"
grep -q 'Deploy complete' <<<"$out2"
echo "OK 09_update_dirty_guard"
CASE
)"

# 10 delete -------------------------------------------------------------------
c10="$(write_case 10_delete <<'CASE'
set -euo pipefail
source "$LP_E2E_ENV"
out="$(cpb delete lifeos -y 2>&1)"
grep -qi 'Deleted' <<<"$out"
test ! -d "$LP_INSTALL"
if grep -q '^alias lifeos=' "$CLAUDE_SHELL_CONFIG"; then
  echo "FAIL: alias 'lifeos' still present after delete" >&2
  exit 1
fi
echo "OK 10_delete"
CASE
)"

# ── run ────────────────────────────────────────────────────────────────
run_case "$P_MAIN" 01_install          "$c01"
run_case "$P_MAIN" 02_manifest         "$c02"
run_case "$P_MAIN" 03_deploy_dryrun    "$c03"
run_case "$P_MAIN" 04_deploy_apply     "$c04"
run_case "$P_MAIN" 05_gitignore        "$c05"
run_case "$P_MAIN" 06_idempotency      "$c06"
run_case "$P_MAIN" 07_full_create_only "$c07"
run_case "$P_AUX"  07b_full_fresh      "$c07b"
run_case "$P_MAIN" 08_update_happy     "$c08"
run_case "$P_MAIN" 09_update_dirty_guard "$c09"
run_case "$P_MAIN" 10_delete           "$c10"

# ── report ─────────────────────────────────────────────────────────────
echo
echo "==== LIFEOS LIFECYCLE E2E RESULTS ===="
for r in "${RESULTS[@]}"; do
  printf '%s  %s\n' "${r%%|*}" "${r#*|}"
done
echo "======================================"
if [ "$FAILED" -ne 0 ]; then
  echo "Some cases FAILED (see logs under $LOG_DIR)." >&2
  exit 1
fi
echo "All LifeOS lifecycle E2E cases passed."
