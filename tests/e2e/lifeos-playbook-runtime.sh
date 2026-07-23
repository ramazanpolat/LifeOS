#!/usr/bin/env bash
# ============================================================================
# lifeos-playbook-runtime.sh — RUNTIME-CORRECTNESS E2E suite for the LifeOS
# claude-playbook conversion.
#
# Scope: deployed-artifact invariants + hook smoke tests. This suite installs
# the playbook and runs `bun bin/deploy.ts --apply --full` ONCE as SETUP, then
# asserts on the deployed tree. It deliberately does NOT cover lifecycle flows
# (install/update/delete mechanics, gitignore leak, idempotency, dirty-guard) —
# those are the sibling suite lifeos-playbook-install.sh.
#
# Philosophy: assert playbook PACKAGING invariants. Upstream quirks are in scope
# only as "must be preserved verbatim" (porting fidelity), never as things to
# fix. Known-accepted and NOT flagged: {{DA_NAME}}/{{PRINCIPAL_NAME}}
# placeholders remain until the Interview.
# NOTE (P1-2/P1-3, round 6): every payload file type that carried a .claude path —
# the PULSE launchd/systemd service templates (.plist/.service), the TOOLS
# *.plist.template launchd job templates (.template, {{HOME}} token), the PULSE
# UI (.tsx) and menu-bar app (.swift), and PULSE code paths (incl. nullish
# `process.env.HOME ?? "~"`-before-.claude) — is now LOCALIZED to the config root
# (see cases 16/16b). A bare __HOME__/{{HOME}} used for a non-.claude path is
# preserved for the service installer's own substitution pass.
#
# Harness: driven through a real herdr pane in a DEDICATED workspace
# (lifeos-e2e-runtime). Cases run in that pane; completion is detected via a
# per-case rc file (robust against pane line-wrapping); the pane screen is
# snapshotted per case to a log for operator visibility. Continue-on-fail: a
# product bug FAILs its case and the run proceeds; the final summary lists every
# case and exits non-zero if any failed.
#
# Sandbox (absolute rule): everything lives under a mktemp -d run root. HOME,
# CLAUDE_PLAYBOOKS_DIR and CLAUDE_SHELL_CONFIG are redirected there. The suite
# never touches ~/.claude, ~/.claude-playbooks, or ~/.zshrc.
#
# Case scripts are written with `write_case NAME >/dev/null <<'CASE' … CASE`
# (path captured in a var) rather than `$(write_case …)`: a heredoc whose body
# contains `)` inside a command substitution breaks bash's `$()` parser.
#
# Debug flags:
#   LP_E2E_KEEP_PANES=1   keep the herdr workspace/panes after the run
#   LP_E2E_KEEP_TMP=1     keep the tmp run root after the run
# ============================================================================

set -uo pipefail   # NOT errexit: cases fail independently; the driver continues.

# ── required tooling ────────────────────────────────────────────────────────
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }
need herdr; need git; need python3; need bun; need claude-playbook; need jq

# ── herdr self-check ────────────────────────────────────────────────────────
if [ "${HERDR_ENV:-}" != "1" ]; then
  echo "Not running inside herdr (HERDR_ENV != 1). Start this suite from a herdr pane." >&2
  exit 1
fi

BUN="$(command -v bun)"
CPB="$(command -v claude-playbook)"
REAL_HOME="$HOME"

# Source under test — derived from THIS checkout so the suite is portable (CI,
# other contributors), matching the lifecycle suite. REPO_ROOT is where the
# suite lives; PRIMARY_CHECKOUT owns the shared object store (works from a
# linked worktree); SRC_BRANCH is the current branch. Override either with
# LP_E2E_SOURCE / LP_E2E_BRANCH to test another branch or a throwaway repo.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GIT_COMMON="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
PRIMARY_CHECKOUT="$(cd "$(dirname "${GIT_COMMON:-$REPO_ROOT/.git}")" && pwd)"
SRC_URL="${LP_E2E_SOURCE:-file://$PRIMARY_CHECKOUT}"
SRC_BRANCH="${LP_E2E_BRANCH:-$(git -C "$REPO_ROOT" branch --show-current)}"

KEEP_PANES="${LP_E2E_KEEP_PANES:-0}"
KEEP_TMP="${LP_E2E_KEEP_TMP:-0}"

TMP_ROOT="${TMPDIR:-/tmp}"; TMP_ROOT="${TMP_ROOT%/}"
LP_RUN="$(mktemp -d "$TMP_ROOT/lifeos-runtime-e2e.XXXXXX")"
# Canonicalize: on macOS TMPDIR is /var/folders/... (a symlink to /private/var).
# `bun bin/deploy.ts` bakes the realpath (import.meta.dir is resolved), so the
# deployed settings.json / paths.ts carry /private/var/... . Resolve here so the
# suite's expected paths match the deployed ones exactly.
LP_RUN="$(cd "$LP_RUN" && pwd -P)"

# Detached HEAD (e.g. a CI checkout of a bare commit) with no LP_E2E_BRANCH
# override leaves SRC_BRANCH empty, which would make the install's `--branch ""`
# fail. Only when the source is ALSO derived from the primary checkout (no
# LP_E2E_SOURCE override) do we build a throwaway bare mirror under the run root,
# materialize a real branch name at HEAD by fetching this checkout's HEAD (never
# creating a branch in the primary checkout), and point the install at it. The
# normal attached-branch path is untouched.
if [ -z "$SRC_BRANCH" ] && [ -z "${LP_E2E_SOURCE:-}" ]; then
  SRC_MIRROR="$LP_RUN/lifeos-src.git"
  git clone --quiet --bare "$PRIMARY_CHECKOUT" "$SRC_MIRROR"
  git -C "$SRC_MIRROR" fetch --quiet "$REPO_ROOT" "HEAD:refs/heads/lp-e2e-head"
  SRC_URL="file://$SRC_MIRROR"
  SRC_BRANCH="lp-e2e-head"
fi
HOME_DIR="$LP_RUN/home"
PB_DIR="$LP_RUN/playbooks"
SHELL_CFG="$LP_RUN/zshrc"
CMD_DIR="$LP_RUN/cmd"
LOG_DIR="$LP_RUN/logs"
L="$PB_DIR/lifeos"                 # deterministic install dir (--name lifeos)
RT="$L/runtime/LIFEOS"
mkdir -p "$HOME_DIR" "$PB_DIR" "$CMD_DIR" "$LOG_DIR" "$LP_RUN/cwd"
: > "$SHELL_CFG"

WS=""            # herdr workspace id
PANE=""          # runner pane id
declare -a RESULTS=()
FAILS=0

cleanup() {
  rc=$?
  if [ "$KEEP_PANES" != "1" ] && [ -n "$WS" ]; then
    herdr workspace close "$WS" >/dev/null 2>&1 || true
  elif [ -n "$WS" ]; then
    echo "herdr workspace kept: $WS (pane $PANE)"
  fi
  if [ "$KEEP_TMP" != "1" ] && [ "$FAILS" -eq 0 ] && [ "$rc" -eq 0 ]; then
    rm -rf "$LP_RUN"
  else
    echo "E2E artifacts kept at: $LP_RUN"
  fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

# ── env file sourced by every case ──────────────────────────────────────────
cat > "$LP_RUN/env.sh" <<EOF
export PATH=$(printf '%q' "$PATH")
export HOME=$(printf '%q' "$HOME_DIR")
export CLAUDE_PLAYBOOKS_DIR=$(printf '%q' "$PB_DIR")
export CLAUDE_SHELL_CONFIG=$(printf '%q' "$SHELL_CFG")
export REAL_HOME=$(printf '%q' "$REAL_HOME")
export LP_RUN=$(printf '%q' "$LP_RUN")
export L=$(printf '%q' "$L")
export RT=$(printf '%q' "$RT")
export PAYLOAD=$(printf '%q' "$L/LifeOS/install")
export BUN=$(printf '%q' "$BUN")
export CPB=$(printf '%q' "$CPB")
export CHECKS=$(printf '%q' "$LP_RUN/checks.py")
export PROBE=$(printf '%q' "$LP_RUN/probe-paths.ts")
export LP_SRC_URL=$(printf '%q' "$SRC_URL")
export LP_SRC_BRANCH=$(printf '%q' "$SRC_BRANCH")
EOF

# ── python check helper (JSON-heavy assertions for cases 1/2/3) ──────────────
cat > "$LP_RUN/checks.py" <<'PYEOF'
import json, os, re, sys

def _load(L):
    return json.load(open(os.path.join(L, 'settings.json')))

def shape(L):
    d = _load(L); env = d.get('env', {}); rt = os.path.join(L, 'runtime', 'LIFEOS'); e = []
    if env.get('LIFEOS_DIR') != rt: e.append('LIFEOS_DIR=%r != %r' % (env.get('LIFEOS_DIR'), rt))
    if env.get('LIFEOS_CONFIG_DIR') != rt: e.append('LIFEOS_CONFIG_DIR=%r != %r' % (env.get('LIFEOS_CONFIG_DIR'), rt))
    for k, v in env.items():
        if not isinstance(v, str):
            e.append('env %s not a string' % k); continue
        if '$HOME' in v or '${HOME}' in v: e.append('env %s still has $HOME: %r' % (k, v))
        if v.startswith('~'): e.append('env %s leading ~: %r' % (k, v))
        if '/' in v and not v.startswith('/'): e.append('env %s path not absolute: %r' % (k, v))
    sl = d.get('statusLine', {}); want = os.path.join(rt, 'LIFEOS_StatusLine.sh')
    if sl.get('command') != want: e.append('statusLine.command=%r != %r' % (sl.get('command'), want))
    if 'spinnerVerbs' not in d: e.append('spinnerVerbs missing')
    if 'spinnerTipsOverride' not in d: e.append('spinnerTipsOverride missing')
    return e

def hygiene(L):
    d = _load(L); e = []
    raw = open(os.path.join(L, 'settings.json')).read()
    if '$HOME/.claude' in raw: e.append('settings.json contains $HOME/.claude')
    if '~/.claude' in raw: e.append('settings.json contains ~/.claude')
    perms = d.get('permissions', {})
    for b in ('allow', 'deny', 'ask'):
        for r in perms.get(b, []):
            if isinstance(r, str) and r.startswith('Write('):
                e.append('Write rule remains in %s: %s' % (b, r))
    allow = perms.get('allow', [])
    for twin in ('Edit(/tmp/**)', 'Edit(/private/tmp/**)', 'Edit(%s/**)' % L):
        if twin not in allow: e.append('missing Edit twin of a dropped Write rule: %s' % twin)
    for ev, groups in d.get('hooks', {}).items():
        for g in groups:
            for h in g.get('hooks', []):
                if h.get('type') != 'command': continue
                c = h.get('command', '')
                if 'SettingsBackport' in c or 'MergeSettings' in c:
                    e.append('backport hook command remains in %s: %s' % (ev, c))
                for tok in c.split():
                    if tok.startswith('/') and tok != L and not tok.startswith(L + '/'):
                        e.append('command path not under L (%s): %s' % (ev, tok))
    return e

def sweep(L):
    pats = [re.compile(r"""\$HOME/\.claude(/|["'])"""),
            re.compile(r"""~/\.claude(/|["' ])"""),
            re.compile(r"""homedir\(\)\s*,\s*['"]\.claude""")]
    # Only rewriteable text files (deploy.ts TEXT_EXT). This deliberately skips
    # .tsx (the Telos Dashboard/Report Next.js templates ship .tsx client
    # components that the deployer cannot rewrite and that the user copies out,
    # not runs in-place), plus images and *.plist.template (unwired launchd).
    exts = ('.ts', '.js', '.sh', '.json', '.md', '.yaml', '.yml', '.toml', '.txt')
    # skills/ and agents/ are swept alongside hooks/ and runtime TOOLS: deployed
    # skill tools and agent prompts must be path-rewritten too (isolation).
    roots = [os.path.join(L, 'hooks'), os.path.join(L, 'runtime', 'LIFEOS', 'TOOLS'),
             os.path.join(L, 'skills'), os.path.join(L, 'agents')]
    e = []
    for root in roots:
        for dp, dirs, fs in os.walk(root):  # os.walk does not follow symlinks (skills/LifeOS is no longer deployed)
            if 'node_modules' in dirs: dirs.remove('node_modules')
            for f in fs:
                if not f.endswith(exts): continue
                p = os.path.join(dp, f)
                try:
                    txt = open(p, encoding='utf-8', errors='replace').read()
                except Exception:
                    continue
                for pat in pats:
                    m = pat.search(txt)
                    if m:
                        e.append('%s :: /%s/ :: %r' % (p, pat.pattern, m.group(0)))
    return e

def main():
    cmd, L = sys.argv[1], sys.argv[2]
    e = {'shape': shape, 'hygiene': hygiene, 'sweep': sweep}[cmd](L)
    if e:
        print('FAIL %s' % cmd)
        for x in e[:40]: print('  - ' + x)
        sys.exit(1)
    print('OK %s' % cmd)

main()
PYEOF

# ── bun probe for the patched paths.ts (case 5) ─────────────────────────────
cat > "$LP_RUN/probe-paths.ts" <<'TSEOF'
const p = process.env.PATHS_TS!;
const m = await import(p);
console.log('CLAUDE=' + m.getClaudeDir());
console.log('LIFEOS=' + m.getLifeosDir());
TSEOF

# ── herdr pane orchestration ────────────────────────────────────────────────
create_workspace() {
  local out
  out="$(herdr workspace create --cwd "$LP_RUN" --label lifeos-e2e-runtime --no-focus 2>/dev/null)"
  WS="$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["workspace"]["workspace_id"])' 2>/dev/null)"
  PANE="$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])' 2>/dev/null)"
  if [ -z "$WS" ] || [ -z "$PANE" ]; then
    echo "Could not create herdr workspace (out: $out)" >&2; exit 1
  fi
  herdr pane rename "$PANE" lifeos-e2e-runner >/dev/null 2>&1 || true
  # Wait for the shell to be live before driving it.
  local tok="__PANE_READY_$RANDOM"
  herdr pane run "$PANE" "echo $tok" >/dev/null 2>&1 || true
  herdr wait output "$PANE" --match "$tok" --timeout 20000 >/dev/null 2>&1 || true
}

# write_case NAME  → reads the case body on stdin, writes an executable script.
# Call as a statement (NOT $(...)): `write_case NAME >/dev/null <<'CASE' … CASE`.
write_case() {
  local name="$1" file="$CMD_DIR/$1.sh"
  cat > "$file"; chmod +x "$file"
}

# run_case NAME FILE DEADLINE_SECONDS → drives the case, records PASS/FAIL, never aborts the driver
run_case() {
  local name="$1" file="$2" deadline_s="${3:-120}"
  local marker="__LP_DONE_${name}_$RANDOM"
  local rc_file="$CMD_DIR/$name.rc" log="$LOG_DIR/$name.log"
  rm -f "$rc_file"
  local line
  line="LP_RUN=$(printf '%q' "$LP_RUN") bash $(printf '%q' "$file"); __rc=\$?; echo ${marker}:\$__rc | tee $(printf '%q' "$rc_file")"
  echo "RUN  $name"
  herdr pane send-text "$PANE" "$line" >/dev/null 2>&1
  herdr pane send-keys "$PANE" Enter >/dev/null 2>&1
  local deadline=$((SECONDS + deadline_s)) rc=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    herdr pane read "$PANE" --source recent --lines 200 --format text > "$log" 2>/dev/null || true
    if [ -f "$rc_file" ]; then
      rc="$(sed -n "s/^${marker}:\([0-9][0-9]*\)$/\1/p" "$rc_file" | tail -1)"
      [ -n "$rc" ] && break
    fi
    sleep 0.5
  done
  if [ -z "$rc" ]; then
    echo "TIMEOUT $name (>${deadline_s}s). Log tail:" >&2
    tail -40 "$log" >&2
    RESULTS+=("FAIL  $name  (timeout after ${deadline_s}s)")
    FAILS=$((FAILS + 1))
    return 0
  fi
  if [ "$rc" -eq 0 ]; then
    echo "PASS $name"
    RESULTS+=("PASS  $name")
  else
    echo "FAIL $name (exit $rc). Log tail:" >&2
    tail -40 "$log" >&2
    RESULTS+=("FAIL  $name  (exit $rc — see $log)")
    FAILS=$((FAILS + 1))
  fi
  return 0
}

# ════════════════════════════════════════════════════════════════════════════
create_workspace
echo "workspace $WS pane $PANE  |  run root $LP_RUN"
echo

# ── SETUP (once): install the playbook + deploy --apply --full ──────────────
F="$CMD_DIR/00_setup.sh"
write_case 00_setup >/dev/null <<'CASE'
set -euo pipefail
source "$LP_RUN/env.sh"
mkdir -p "$HOME" "$CLAUDE_PLAYBOOKS_DIR"
: > "$CLAUDE_SHELL_CONFIG"
"$CPB" --playbooks-dir "$CLAUDE_PLAYBOOKS_DIR" --shell-config "$CLAUDE_SHELL_CONFIG" \
  install "$LP_SRC_URL" --branch "$LP_SRC_BRANCH" --name lifeos --no-alias
test -f "$L/bin/deploy.ts"
cd "$L"
CLAUDE_CONFIG_DIR="$L" "$BUN" bin/deploy.ts --apply --full
test -f "$L/settings.json"
test -d "$L/runtime/LIFEOS"
test -f "$L/runtime/LIFEOS/VERSION"
# Isolation is inherent: the install target is the sandbox playbooks dir, so the
# deployed root must live under the mktemp run root (leak-into-real-dirs is the
# sibling lifecycle suite's concern, not a runtime-correctness invariant).
case "$L" in "$LP_RUN"/*) : ;; *) echo "install dir $L escaped run root $LP_RUN" >&2; exit 1 ;; esac
echo "SETUP OK L=$L"
CASE
run_case 00_setup "$F" 420

if [ "$FAILS" -ne 0 ]; then
  echo
  echo "SETUP failed — skipping assertion cases (nothing deployed to assert on)." >&2
  printf '%s\n' "${RESULTS[@]}"
  exit 1
fi

# ── 1. settings-shape ───────────────────────────────────────────────────────
F="$CMD_DIR/01_settings_shape.sh"
write_case 01_settings_shape >/dev/null <<'CASE'
set -euo pipefail
source "$LP_RUN/env.sh"
python3 "$CHECKS" shape "$L"
test -x "$RT/LIFEOS_StatusLine.sh"
CASE
run_case 01_settings_shape "$F"

# ── 2. settings-hygiene ─────────────────────────────────────────────────────
F="$CMD_DIR/02_settings_hygiene.sh"
write_case 02_settings_hygiene >/dev/null <<'CASE'
set -euo pipefail
source "$LP_RUN/env.sh"
# Fast substring guards (belt-and-suspenders around the python check).
test "$(grep -c '\$HOME/\.claude' "$L/settings.json" || true)" = 0
test "$(grep -c '~/\.claude' "$L/settings.json" || true)" = 0
python3 "$CHECKS" hygiene "$L"
CASE
run_case 02_settings_hygiene "$F"

# ── 3. rewrite-sweep + substring-guard fidelity ─────────────────────────────
F="$CMD_DIR/03_rewrite_sweep.sh"
write_case 03_rewrite_sweep >/dev/null <<'CASE'
set -euo pipefail
source "$LP_RUN/env.sh"
# Sweep hooks/, runtime TOOLS/, skills/ and agents/ for stray home-form paths.
python3 "$CHECKS" sweep "$L"
# No BARE ../…/LIFEOS/ imports may survive in deployed skill/agent .ts — RrelL
# must have retargeted every one to ../…/runtime/LIFEOS/ (an isolation breach
# otherwise: ../…/LIFEOS resolves to the nonexistent <root>/LIFEOS). Match only
# a ../ chain immediately followed by LIFEOS/ (…/runtime/LIFEOS/ never matches).
bare="$(grep -rlnE "(\.\./)+LIFEOS/" "$L/skills" "$L/agents" --include='*.ts' 2>/dev/null | wc -l | tr -d ' ' || true)"  # grep exits 1 on 0 matches (pipefail)
[ "$bare" -eq 0 ] || { echo "bare ../…/LIFEOS/ imports remain in $bare deployed skill/agent .ts file(s)" >&2; grep -rnE "(\.\./)+LIFEOS/" "$L/skills" "$L/agents" --include='*.ts' | head -10 >&2; exit 1; }
# The two substring guards must survive path-rewrite byte-identical to payload.
for hk in KittyEnvPersist.hook.ts LoadContext.hook.ts; do
  dep="$(grep -n "includes('/.claude/Agents/')" "$L/hooks/$hk")"
  pay="$(grep -n "includes('/.claude/Agents/')" "$PAYLOAD/hooks/$hk")"
  if [ "$dep" != "$pay" ]; then
    echo "substring guard drifted in $hk: dep=[$dep] pay=[$pay]" >&2; exit 1
  fi
done
echo "sweep + guards OK"
CASE
run_case 03_rewrite_sweep "$F"

# ── 4. import-resolution (bun build) ────────────────────────────────────────
F="$CMD_DIR/04_import_resolution.sh"
write_case 04_import_resolution >/dev/null <<'CASE'
set -euo pipefail
source "$LP_RUN/env.sh"
cd "$L"
# hooks: a ./-chain importer (PreToolGuard) + a ../LIFEOS importer (IntegrityCheck,
# rewritten to ../runtime/LIFEOS by RrelL); the patched lib/paths.ts; two TOOLS
# files whose PAYLOAD twins import ../../hooks/ (RrelH -> absolute); and a deployed
# SKILL tool (AudioEditor/Tools/Analyze.ts) whose payload twin imports
# ../../../LIFEOS/TOOLS/Inference.ts (RrelL -> ../../../runtime/LIFEOS/), proving
# skills are path-rewritten AND their runtime imports resolve.
files="hooks/PreToolGuard.hook.ts hooks/IntegrityCheck.hook.ts hooks/lib/paths.ts runtime/LIFEOS/TOOLS/MemoryStatus.ts runtime/LIFEOS/TOOLS/CheckFileBoundary.ts skills/AudioEditor/Tools/Analyze.ts"
# Confirm the two TOOLS twins really do carry ../../hooks/ imports in the payload.
grep -q '\.\./\.\./hooks/' "$PAYLOAD/LIFEOS/TOOLS/MemoryStatus.ts"
grep -q '\.\./\.\./hooks/' "$PAYLOAD/LIFEOS/TOOLS/CheckFileBoundary.ts"
# The skill tool's payload twin has a BARE ../../../LIFEOS/ import; the deployed
# copy must have it retargeted to ../../../runtime/LIFEOS/ (RrelL at skill depth).
grep -qE "(\.\./){3}LIFEOS/TOOLS/Inference" "$PAYLOAD/skills/AudioEditor/Tools/Analyze.ts"
grep -qE "(\.\./){3}runtime/LIFEOS/TOOLS/Inference" "$L/skills/AudioEditor/Tools/Analyze.ts" \
  || { echo "skill tool import not rewritten to ../../../runtime/LIFEOS/" >&2; exit 1; }
fails=0
for f in $files; do
  bn="$(basename "$f")"
  out="$("$BUN" build "$L/$f" --target=bun --outfile "$LP_RUN/build-$bn.js" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ] || printf '%s' "$out" | grep -qiE 'cannot find|could not resolve|error while'; then
    echo "BUILD FAIL $f (rc=$rc):" >&2; printf '%s\n' "$out" >&2; fails=$((fails+1))
  else
    echo "build ok: $f"
  fi
done
test "$fails" -eq 0
CASE
run_case 04_import_resolution "$F"

# ── 5. paths-env (patched getClaudeDir / getLifeosDir) ──────────────────────
F="$CMD_DIR/05_paths_env.sh"
write_case 05_paths_env >/dev/null <<'CASE'
set -euo pipefail
source "$LP_RUN/env.sh"
# LIFEOS_DIR unset here: getLifeosDir() must fall back to the deployed absolute
# runtime path (deploy R3-rewrote the join(homedir(),'.claude','LIFEOS') tail).
# getClaudeDir() must honor CLAUDE_CONFIG_DIR first (deploy patch).
out="$(env -u LIFEOS_DIR -u CLAUDE_PLUGIN_ROOT CLAUDE_CONFIG_DIR="$L" PATHS_TS="$L/hooks/lib/paths.ts" "$BUN" "$PROBE")"
echo "$out"
grep -qx "CLAUDE=$L" <<<"$out"
grep -qx "LIFEOS=$RT" <<<"$out"
CASE
run_case 05_paths_env "$F"

# ── 6. user-contract (USER symlink + MEMORY scaffold) ───────────────────────
F="$CMD_DIR/06_user_contract.sh"
write_case 06_user_contract >/dev/null <<'CASE'
set -euo pipefail
source "$LP_RUN/env.sh"
test -L "$RT/USER"
resolved="$(cd "$RT/USER" && pwd -P)"
want="$(cd "$L/USER" && pwd -P)"
[ "$resolved" = "$want" ] || { echo "USER symlink resolves to $resolved, want $want" >&2; exit 1; }
n="$(find "$L/USER" -type f | wc -l | tr -d ' ')"
test "$n" -gt 50 || { echo "USER file count $n <= 50" >&2; exit 1; }
for s in WORK KNOWLEDGE LEARNING STATE OBSERVABILITY SKILLS; do
  test -d "$RT/MEMORY/$s" || { echo "MEMORY/$s missing" >&2; exit 1; }
done
echo "user-contract OK (USER files=$n)"
CASE
run_case 06_user_contract "$F"

# ── 7. porting-fidelity (skills count, byte-identity, VERSION) ──────────────
F="$CMD_DIR/07_porting_fidelity.sh"
write_case 07_porting_fidelity >/dev/null <<'CASE'
set -euo pipefail
source "$LP_RUN/env.sh"
n="$(ls -1 "$L/skills" | wc -l | tr -d ' ')"
test "$n" -ge 50 || { echo "skills entries $n < 50" >&2; exit 1; }
# Deployed skills are path-localized (case 03/04 cover that rewrite), so the
# Interview skill is no longer byte-identical to the payload. Assert STRUCTURAL
# porting fidelity instead — same file tree, nothing dropped/added — plus a
# non-empty SKILL.md.
only="$(diff -rq "$PAYLOAD/skills/Interview" "$L/skills/Interview" 2>/dev/null | grep '^Only in' || true)"
[ -z "$only" ] || { echo "Interview skill tree drifted from payload:" >&2; printf '%s\n' "$only" >&2; exit 1; }
test -s "$L/skills/Interview/SKILL.md" || { echo "deployed Interview/SKILL.md is empty" >&2; exit 1; }
ver="$(tr -d '[:space:]' < "$RT/VERSION")"
pbver="$(grep '^version' "$L/.playbook" | sed -E 's/.*"([^"]+)".*/\1/')"
[ "$ver" = "$pbver" ] || { echo "VERSION=$ver != .playbook version=$pbver" >&2; exit 1; }
echo "porting-fidelity OK (skills=$n version=$ver)"
CASE
run_case 07_porting_fidelity "$F"

# ── 8. hook-smoke: SessionStart (LoadContext) ───────────────────────────────
F="$CMD_DIR/08_smoke_sessionstart.sh"
write_case 08_smoke_sessionstart >/dev/null <<'CASE'
set -euo pipefail
source "$LP_RUN/env.sh"
cd "$LP_RUN/cwd"
evt="$(printf '{"session_id":"e2e","source":"startup","hook_event_name":"SessionStart","cwd":"%s"}' "$L")"
set +e
printf '%s' "$evt" | CLAUDE_CONFIG_DIR="$L" LIFEOS_DIR="$RT" "$BUN" "$L/hooks/LoadContext.hook.ts" >"$LP_RUN/lc.out" 2>"$LP_RUN/lc.err"
rc=$?
set -e
echo "rc=$rc"; echo "--- stderr ---"; cat "$LP_RUN/lc.err" || true
test "$rc" -eq 0
if grep -qiE 'cannot find (module|package)|could not resolve' "$LP_RUN/lc.err"; then echo "module-resolution error" >&2; exit 1; fi
if grep -q "$REAL_HOME/.claude" "$LP_RUN/lc.err"; then echo "leaked real ~/.claude path in stderr" >&2; exit 1; fi
echo "LoadContext smoke OK"
CASE
run_case 08_smoke_sessionstart "$F"

# ── 9. hook-smoke: PreToolUse (PreToolGuard) + file-leak / junk-dir guard ───
F="$CMD_DIR/09_smoke_pretooluse.sh"
write_case 09_smoke_pretooluse >/dev/null <<'CASE'
set -euo pipefail
source "$LP_RUN/env.sh"
cd "$LP_RUN/cwd"

# Snapshot the real ~/.claude top-level BEFORE (leak detector), plant a marker.
before="$(ls -1A "$REAL_HOME/.claude" 2>/dev/null | sort || true)"
: > "$LP_RUN/marker9"

run_smoke() {
  local hook="$1" evt="$2" tag="$3" rc
  set +e
  printf '%s' "$evt" | CLAUDE_CONFIG_DIR="$L" LIFEOS_DIR="$RT" "$BUN" "$hook" >"$LP_RUN/$tag.out" 2>"$LP_RUN/$tag.err"
  rc=$?
  set -e
  echo "$tag rc=$rc"
  test "$rc" -eq 0
  if grep -qiE 'cannot find (module|package)|could not resolve' "$LP_RUN/$tag.err"; then echo "$tag module-resolution error" >&2; cat "$LP_RUN/$tag.err" >&2; exit 1; fi
  if grep -q "$REAL_HOME/.claude" "$LP_RUN/$tag.err"; then echo "$tag leaked real ~/.claude path" >&2; exit 1; fi
}

run_smoke "$L/hooks/PreToolGuard.hook.ts" '{"tool_name":"Bash","tool_input":{"command":"ls"},"hook_event_name":"PreToolUse"}' pretool
run_smoke "$L/hooks/LoadContext.hook.ts" "$(printf '{"session_id":"e2e","source":"startup","hook_event_name":"SessionStart","cwd":"%s"}' "$L")" loadctx2

# No NEW top-level entry under the real ~/.claude (deployed hooks must stay in the sandbox).
after="$(ls -1A "$REAL_HOME/.claude" 2>/dev/null | sort || true)"
if [ "$before" != "$after" ]; then
  echo "real ~/.claude top-level changed during smoke run:" >&2
  diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") >&2 || true
  exit 1
fi

# No junk dirs from unexpanded path bugs ($HOME / ${HOME} / ~ / {{...}}) in the
# sandbox home or the run cwd.
junk="$(find "$HOME" "$LP_RUN/cwd" -maxdepth 4 \( -name '$HOME' -o -name '${HOME}' -o -name '~' -o -name '*{{*' \) 2>/dev/null || true)"
if [ -n "$junk" ]; then echo "junk (unexpanded-path) entries found:" >&2; echo "$junk" >&2; exit 1; fi
echo "PreToolUse smoke + leak/junk guards OK"
CASE
run_case 09_smoke_pretooluse "$F"

# ── 10. statusline exec ─────────────────────────────────────────────────────
F="$CMD_DIR/10_statusline_exec.sh"
write_case 10_statusline_exec >/dev/null <<'CASE'
set -euo pipefail
source "$LP_RUN/env.sh"
cd "$LP_RUN/cwd"
before="$(ls -1A "$REAL_HOME/.claude" 2>/dev/null | sort || true)"
in="$(printf '{"model":{"display_name":"opus-e2e"},"workspace":{"current_dir":"%s"},"context_window":{"used_percentage":10},"cost":{"total_cost_usd":0,"total_lines_added":0,"total_lines_removed":0},"rate_limits":{"five_hour":{"used_percentage":5}}}' "$L")"
set +e
printf '%s' "$in" | LIFEOS_DIR="$RT" CLAUDE_CONFIG_DIR="$L" HOME="$HOME" "$RT/LIFEOS_StatusLine.sh" >"$LP_RUN/sl.out" 2>"$LP_RUN/sl.err"
rc=$?
set -e
echo "rc=$rc bytes=$(wc -c <"$LP_RUN/sl.out" | tr -d ' ')"
test "$rc" -eq 0                       # 0-ish exit
test -s "$LP_RUN/sl.out"               # non-empty statusline
after="$(ls -1A "$REAL_HOME/.claude" 2>/dev/null | sort || true)"
[ "$before" = "$after" ] || { echo "real ~/.claude changed during statusline run" >&2; exit 1; }
junk="$(find "$HOME" "$LP_RUN/cwd" -maxdepth 4 \( -name '$HOME' -o -name '${HOME}' -o -name '~' -o -name '*{{*' \) 2>/dev/null || true)"
[ -z "$junk" ] || { echo "junk entries: $junk" >&2; exit 1; }
tmpjunk="$(find /tmp -maxdepth 1 \( -name '$HOME*' -o -name '*{{*' \) 2>/dev/null || true)"
[ -z "$tmpjunk" ] || { echo "tmp junk entries: $tmpjunk" >&2; exit 1; }
echo "statusline exec OK"
CASE
run_case 10_statusline_exec "$F"

# Case 11 — R6 regression (2026-07-22, commit 2b79782). Upstream's two-step
# idiom (`const CLAUDE = join(HOME, ".claude"); join(CLAUDE, "LIFEOS/TOOLS")`)
# escaped the home-token rewrite rules, leaving 32 deployed files resolving the
# runtime at <root>/LIFEOS — the tracked LifeOS/ payload dir on a
# case-insensitive FS. Live symptom: MemoryHealthCheck reported
# MemorySystem/MemoryReviewer/MemoryWriter "missing" (it searched
# LifeOS/Tools/) and wrote its health log into the payload tree. R6a/R6b now
# rewrite quoted "LIFEOS/..." segments and separate-arg 'LIFEOS' join args.
F="$CMD_DIR/11_r6_configroot_lifeos.sh"   # was missing: run_case reused case 10's file
write_case 11_r6_configroot_lifeos >/dev/null <<'CASE'
set -euo pipefail
source "$LP_RUN/env.sh"
# (a) no quoted config-root-relative LIFEOS/ PATH string survives in deployed
# code. R6a DELIBERATELY exempts a "LIFEOS/…" literal that is the argument of a
# string-matching method (rel.startsWith("LIFEOS/…"), p.includes('LIFEOS/USER/'),
# value.startsWith("LIFEOS/")): those are comparison operands against external or
# original-form relative paths, NOT filesystem paths to localize (see case 14 and
# ReleaseAudit's release-privacy audit). Filter those out here too; anything that
# REMAINS is a genuine un-localized path literal → regression.
stray="$(grep -rnE "['\"\`]LIFEOS/" "$L/hooks" "$RT/TOOLS" 2>/dev/null \
  | grep -v '@LIFEOS' \
  | grep -vE "\.(startsWith|endsWith|includes|indexOf|lastIndexOf|match|search|split|replace|replaceAll)\([[:space:]]*['\"\`]LIFEOS/" \
  || true)"
if [ -n "$stray" ]; then
  echo "R6a regression: quoted LIFEOS/ PATH string(s) remain (not string-method operands):" >&2
  printf '%s\n' "$stray" >&2
  exit 1
fi
# (b) no separate-arg 'LIFEOS' join args survive
hits2="$(grep -rE "(join|resolve|pathResolve)\([^)]*['\"]LIFEOS['\"]" "$L/hooks" "$RT/TOOLS" 2>/dev/null | wc -l | tr -d ' ' || true)"  # grep exits 1 on 0 matches (pipefail)
[ "$hits2" -eq 0 ] || { echo "R6b regression: $hits2 separate-arg 'LIFEOS' join(s) remain" >&2; exit 1; }
# (c) MemoryHealthCheck finds every required tool/hook file on disk
out="$(cd "$L" && CLAUDE_CONFIG_DIR="$L" LIFEOS_DIR="$RT" bun "$RT/TOOLS/MemoryHealthCheck.ts" 2>&1 || true)"
echo "$out" | grep -q 'tool-file-present' || { echo "MemoryHealthCheck produced no tool-file findings — did it run?" >&2; exit 1; }
echo "$out" | grep -q 'file-missing' && { echo "MemoryHealthCheck still reports missing files:" >&2; echo "$out" | grep 'file-missing' | head -5 >&2; exit 1; }
# (d) the health check wrote nothing into the tracked payload dir
[ ! -e "$L/LifeOS/MEMORY" ] || { echo "health check wrote into the payload tree: LifeOS/MEMORY exists" >&2; exit 1; }
echo "r6-configroot-lifeos OK (0 stragglers, health check clean, payload untouched)"
CASE
run_case 11_r6_configroot_lifeos "$F"

# ── 12. skills/LifeOS is NOT deployed (P1-1) ────────────────────────────────
# The stock LifeOS installer skill is intentionally NOT deployed (reversing
# round-3's loader-symlink decision): bin/deploy.ts IS the installer, and the
# stock /lifeos-setup skill is both redundant AND a footgun — its Setup workflow
# runs DeployCore/ScaffoldUser against <configRoot>/LIFEOS, which on
# case-insensitive macOS IS the tracked LifeOS/ payload, corrupting the checkout.
# Assert skills/LifeOS is ABSENT after a fresh deploy. Onboarding is unaffected:
# Interview is a SEPARATE skill and is still deployed.
F="$CMD_DIR/12_skills_not_deployed.sh"
write_case 12_skills_not_deployed >/dev/null <<'CASE'
set -euo pipefail
source "$LP_RUN/env.sh"
if [ -e "$L/skills/LifeOS" ] || [ -L "$L/skills/LifeOS" ]; then
  echo "skills/LifeOS must NOT be deployed (P1-1), but it exists:" >&2
  ls -la "$L/skills/LifeOS" >&2
  exit 1
fi
# The separate Interview skill IS deployed (onboarding unaffected).
test -s "$L/skills/Interview/SKILL.md" || { echo "Interview skill not deployed" >&2; exit 1; }
echo "skills/LifeOS not deployed OK (Interview present)"
CASE
run_case 12_skills_not_deployed "$F"

# ── 13. package.json is deploy-managed (P2-a) ───────────────────────────────
# package.json must be hash-enrolled in the deploy state (not copy-if-missing),
# so an upstream dependency bump refreshes on the next deploy. Light check: the
# state records package.json and the recorded hash matches the deployed file.
F="$CMD_DIR/13_package_managed.sh"
write_case 13_package_managed >/dev/null <<'CASE'
set -euo pipefail
source "$LP_RUN/env.sh"
test -f "$L/package.json" || { echo "deployed package.json missing" >&2; exit 1; }
python3 - "$L" <<'PY'
import json, os, sys, hashlib
L = sys.argv[1]
st = json.load(open(os.path.join(L, '.lifeos-deploy-state.json')))
h = st.get('files', {}).get('package.json')
if not h:
    print('FAIL: package.json is not enrolled in .lifeos-deploy-state.json'); sys.exit(1)
disk = hashlib.sha256(open(os.path.join(L, 'package.json'), 'rb').read()).hexdigest()
if disk != h:
    print('FAIL: enrolled hash %s != on-disk %s' % (h, disk)); sys.exit(1)
print('OK: package.json enrolled and hash matches on-disk (%s...)' % h[:12])
PY
CASE
run_case 13_package_managed "$F"

# ── 14. R6a semantic-comparison exemption (P1-1) ────────────────────────────
# R6a localizes config-root-relative "LIFEOS/…" PATH strings to runtime/LIFEOS/,
# but must NOT touch a "LIFEOS/…" literal that is a string-matching method's
# argument — that is a comparison operand, not a path. The canonical case is
# PULSE/Tools/ReleaseAudit.ts, whose rel.startsWith("LIFEOS/…") tests an EXTERNAL
# staged release (rel = relative(STAGING, file), rooted at LIFEOS/); rewriting it
# would silently break the release privacy audit. This asserts the comparisons
# survive verbatim WHILE ReleaseAudit's own filesystem join AND a genuine
# path-construction site elsewhere still localize.
F="$CMD_DIR/14_r6a_semantic_exemption.sh"
write_case 14_r6a_semantic_exemption >/dev/null <<'CASE'
set -euo pipefail
source "$LP_RUN/env.sh"
ra="$RT/PULSE/Tools/ReleaseAudit.ts"
test -f "$ra" || { echo "deployed ReleaseAudit.ts missing at $ra" >&2; exit 1; }
# (a) the semantic startsWith("LIFEOS/…") comparisons survive VERBATIM.
grep -qF 'startsWith("LIFEOS/USER/")' "$ra" || { echo "FAIL: startsWith(\"LIFEOS/USER/\") was rewritten" >&2; grep -n 'LIFEOS/USER' "$ra" >&2; exit 1; }
grep -qF 'startsWith("LIFEOS/MEMORY/PULSE_DATA/")' "$ra" || { echo "FAIL: startsWith(\"LIFEOS/MEMORY/PULSE_DATA/\") was rewritten" >&2; grep -n 'PULSE_DATA' "$ra" >&2; exit 1; }
# and none of them gained a runtime/ prefix (over-localization).
if grep -q 'startsWith("runtime/LIFEOS/' "$ra"; then echo "FAIL: a semantic startsWith literal was localized" >&2; grep -n 'startsWith("runtime/LIFEOS/' "$ra" >&2; exit 1; fi
# (b) ReleaseAudit's OWN filesystem join IS localized: upstream
# join(homedir(), ".claude/LIFEOS/USER/CONFIG/release-audit-strings.json") baked
# to the deployed runtime path (R2), losing ~/.claude.
grep -qF "runtime/LIFEOS/USER/CONFIG/release-audit-strings.json" "$ra" || { echo "FAIL: ReleaseAudit fs join not localized" >&2; grep -n 'release-audit-strings' "$ra" >&2; exit 1; }
if grep -q '\.claude/LIFEOS/USER/CONFIG/release-audit-strings' "$ra"; then echo "FAIL: ReleaseAudit still carries a ~/.claude fs join" >&2; exit 1; fi
# (c) a genuine PATH-construction site elsewhere still localizes: MemoryHealthCheck
# join(CLAUDE, "LIFEOS/TOOLS") → "runtime/LIFEOS/TOOLS".
mh="$RT/TOOLS/MemoryHealthCheck.ts"
grep -qF '"runtime/LIFEOS/TOOLS"' "$mh" || { echo "FAIL: MemoryHealthCheck path join not localized" >&2; grep -n 'LIFEOS/TOOLS' "$mh" >&2; exit 1; }
echo "R6a semantic exemption OK (ReleaseAudit comparisons intact; its fs join + MemoryHealthCheck localized)"
CASE
run_case 14_r6a_semantic_exemption "$F"

# ── 15. Handlebars templates are path-rewritten (P2-5) ──────────────────────
# .hbs is in TEXT_EXT, so skills/Prompting/Templates/**.hbs get the step-8
# rewrite: their `bun run ~/.claude/Skills/…` commands would otherwise hit the
# real ~/.claude. The rewrite must strip ~/.claude while leaving Handlebars
# {{…}} syntax intact (the rewrite rules never match {{…}}).
F="$CMD_DIR/15_hbs_rewrite.sh"
write_case 15_hbs_rewrite >/dev/null <<'CASE'
set -euo pipefail
source "$LP_RUN/env.sh"
tdir="$L/skills/Prompting/Templates"
test -d "$tdir" || { echo "deployed Handlebars templates dir missing: $tdir" >&2; exit 1; }
n="$(find "$tdir" -name '*.hbs' | wc -l | tr -d ' ')"
test "$n" -ge 2 || { echo "expected >=2 deployed .hbs templates, found $n" >&2; exit 1; }
# No ~/.claude or $HOME/.claude survives in ANY deployed .hbs.
leak="$(grep -rnE "~/\.claude|\\\$HOME/\.claude|\\\$\{HOME\}/\.claude" "$tdir" --include='*.hbs' || true)"
if [ -n "$leak" ]; then echo "FAIL: ~/.claude survived in deployed .hbs:" >&2; printf '%s\n' "$leak" >&2; exit 1; fi
# The specific commands were localized to the config root, and Handlebars vars
# survive byte-for-byte.
tc="$tdir/Evals/TestCase.hbs"
grep -qF "$L/Skills/Evals/EvalServer/Lib/run-eval.ts" "$tc" || { echo "FAIL: TestCase.hbs run-eval path not localized to \$L" >&2; grep -n 'run-eval' "$tc" >&2; exit 1; }
grep -qF '{{test_suite.name}}' "$tc" || { echo "FAIL: Handlebars {{test_suite.name}} corrupted in TestCase.hbs" >&2; exit 1; }
echo "Handlebars rewrite OK ($n .hbs; 0 ~/.claude; {{…}} intact)"
CASE
run_case 15_hbs_rewrite "$F"

# ── 16. PULSE service templates + code are localized (P1-2 / P1-3) ──────────
# P1-2: .plist/.service are now in TEXT_EXT, so RH1/RH4 rewrite their
# __HOME__/.claude paths to absolute config-root paths (<RT>/<CR>) while leaving a
# bare __HOME__ — used for a NON-.claude path — intact for Pulse's own
# `sed s|__HOME__|$HOME|` / `.replaceAll("__HOME__", HOME)` pass. P1-3: HOMETOK now
# also consumes `?? "…"` fallbacks, so `process.env.HOME ?? "~"` immediately before
# a .claude path localizes too. Without these, generated launchd/systemd units and
# the 15+ nullish-HOME PULSE .ts files escape to the real ~/.claude.
F="$CMD_DIR/16_pulse_localized.sh"
write_case 16_pulse_localized >/dev/null <<'CASE'
set -euo pipefail
source "$LP_RUN/env.sh"
pulse="$RT/PULSE"
test -d "$pulse" || { echo "deployed PULSE dir missing: $pulse" >&2; exit 1; }
# (a) 0 __HOME__/.claude and 0 ~/.claude / $HOME/.claude in deployed .plist/.service.
bad="$(grep -rnE '__HOME__/\.claude|~/\.claude|\$HOME/\.claude|\$\{HOME\}/\.claude' "$pulse" --include='*.plist' --include='*.service' 2>/dev/null || true)"
if [ -n "$bad" ]; then echo "FAIL: home-form .claude paths survive in deployed PULSE .plist/.service:" >&2; printf '%s\n' "$bad" >&2; exit 1; fi
# (b) they carry the absolute config-root runtime path <RT> instead.
grep -qF "$RT/PULSE" "$pulse/com.lifeos.pulse.plist"   || { echo "FAIL: pulse.plist not localized to <RT>" >&2; exit 1; }
grep -qF "$RT/PULSE" "$pulse/com.lifeos.pulse.service" || { echo "FAIL: pulse.service not localized to <RT>" >&2; exit 1; }
# (c) a bare __HOME__ used for a NON-.claude path is PRESERVED for Pulse's own
# substitution (Environment=HOME=__HOME__; __HOME__/.bun/bin).
grep -qE '^Environment=HOME=__HOME__$' "$pulse/com.lifeos.pulse.service" || { echo "FAIL: bare __HOME__ (Environment=HOME) was not preserved" >&2; exit 1; }
grep -qF '__HOME__/.bun/bin' "$pulse/com.lifeos.pulse.service" || { echo "FAIL: bare __HOME__/.bun/bin was not preserved" >&2; exit 1; }
# (d) P1-3: 0 `process.env.HOME ?? "~", ".claude"` escapes survive in ANY deployed
# PULSE .ts (the only .claude-adjacent nullish-HOME shape in the payload). The
# env-assignment form `process.env.HOME ?? ""` is NOT a .claude path and stays.
esc="$(grep -rnF 'process.env.HOME ?? "~", ".claude"' "$pulse" --include='*.ts' 2>/dev/null || true)"
if [ -n "$esc" ]; then echo "FAIL: nullish-HOME .claude escapes survive in deployed PULSE .ts:" >&2; printf '%s\n' "$esc" >&2; exit 1; fi
# spot-check the three named files carry NO ~/.claude / $HOME/.claude and DO carry
# the localized config-root runtime path.
for f in run-job.ts lib.ts VoiceServer/voice.ts; do
  if grep -qE '(~|\$HOME|\$\{HOME\})/\.claude' "$pulse/$f"; then echo "FAIL: $f still carries a ~/.claude path" >&2; grep -nE '(~|\$HOME|\$\{HOME\})/\.claude' "$pulse/$f" >&2; exit 1; fi
  grep -qF "$RT" "$pulse/$f" || { echo "FAIL: $f not localized to <RT> (no config-root runtime path)" >&2; exit 1; }
done
echo "PULSE localization OK (.plist/.service on <RT>; bare __HOME__ preserved; 0 nullish-HOME .claude escapes)"
CASE
run_case 16_pulse_localized "$F"

# 16b — the round-6 extended extensions (.template launchd job templates,
# .tsx Pulse UI + dashboard/report templates, .swift menu-bar app) are now in
# TEXT_EXT and must carry 0 home-form .claude escapes after deploy.
F="$CMD_DIR/16b_extended_exts_localized.sh"
write_case 16b_extended_exts_localized >/dev/null <<'CASE'
set -euo pipefail
source "$LP_RUN/env.sh"
esc='(__HOME__|\{\{HOME\}\}|~|\$HOME|\$\{HOME\})/\.claude'
for ext in template tsx swift; do
  hits="$(grep -rlE "$esc" "$RT" --include="*.$ext" 2>/dev/null || true)"
  if [ -n "$hits" ]; then echo "FAIL: home-form .claude paths survive in deployed *.$ext:" >&2; printf '%s\n' "$hits" >&2; exit 1; fi
done
# the WorkSweep launchd job template now points its ProgramArguments at the
# config-root runtime, not {{HOME}}/.claude.
tmpl="$(ls "$RT"/TOOLS/*.plist.template 2>/dev/null | head -1)"
[ -n "$tmpl" ] && grep -qF "$RT/TOOLS" "$tmpl" || { echo "FAIL: launchd job template not localized to <RT>/TOOLS" >&2; exit 1; }
echo "extended-ext localization OK (.template/.tsx/.swift carry 0 .claude escapes)"
CASE
run_case 16b_extended_exts_localized "$F"

# ════════════════════════════════════════════════════════════════════════════
echo
echo "================ RUNTIME-CORRECTNESS SUMMARY ================"
printf '%s\n' "${RESULTS[@]}"
echo "============================================================"
echo "run root: $LP_RUN"
if [ "$FAILS" -eq 0 ]; then
  echo "All ${#RESULTS[@]} cases passed."
  exit 0
else
  echo "$FAILS case(s) FAILED."
  exit 1
fi
