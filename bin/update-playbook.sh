#!/bin/sh
# LifeOS playbook — update script (invoked by `claude-playbook update lifeos`).
# The CLI runs this with cwd = the playbook root and CLAUDE_CONFIG_DIR set.
# It fast-forwards the checkout, then re-overlays the runtime via the
# idempotent deploy (which never overwrites user-modified files).
set -e

# Resolve and enter the playbook root (parent of bin/), independent of cwd.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

# Refuse if TRACKED files have local modifications. Untracked/ignored files
# are expected — the deployed runtime and USER data live there.
#
# EXCEPTION: `.playbook` is the claude-playbook manifest, which the CLI itself
# rewrites at install time (it injects the `[source]` repository/branch), so it
# is ALWAYS shown as modified in a CLI-installed playbook. Counting it as a
# blocking change would make `claude-playbook update` refuse on every install.
# Exclude it from the clean-tree check; it is CLI-owned metadata, never payload.
DIRTY=$(git status --porcelain --untracked-files=no | grep -vE '^.. \.playbook$' || true)
if [ -n "$DIRTY" ]; then
  echo "update-playbook: tracked files are modified — commit or stash them first." >&2
  echo "$DIRTY" >&2
  exit 1
fi

# Preserve the CLI-injected [source] metadata across the pull — as a PARTIAL
# MERGE, not a wholesale restore. The claude-playbook CLI writes source fields
# (notably `branch = "..."`, plus an overriding `repository` when the user
# installed from a fork) into the tracked `.playbook` at install time, so
# `.playbook` always shows as locally modified. A plain `git pull --ff-only`
# then REFUSES whenever the incoming commit ALSO touches `.playbook` — e.g. an
# upstream version bump — with "Your local changes to .playbook would be
# overwritten by merge". To stay update-safe AND let upstream's own [source]
# edits (a changed `update_script`, a new key) reach existing installs:
#   1. diff the local [source] against the COMMITTED one (`git show HEAD:.playbook`)
#      to identify ONLY the CLI-injected keys (present-and-new, or present-and-
#      different), BEFORE any checkout,
#   2. restore `.playbook` to its committed form so the fast-forward is clean,
#   3. pull (now unobstructed — the upstream version bump + [source] edits land),
#   4. merge just the CLI-injected keys back into the freshly pulled [source]
#      (replace matching keys in place; append keys the pulled section lacks).
# A blanket re-append of the saved local block (the previous approach) discarded
# every upstream [source] change. Pure POSIX sh + awk (no python).

INJECT_TMP="$(mktemp "${TMPDIR:-/tmp}/lifeos-src-inject.XXXXXX")"
trap 'rm -f "$INJECT_TMP" "$INJECT_TMP.committed" "$INJECT_TMP.local"' EXIT INT TERM

# _source_body — emit only the `key = value` body lines of the [source] section
# read on stdin (the `[source]` header, blank lines, and other sections dropped).
_source_body() {
  awk '
    /^\[source\]/ { f=1; next }
    f==1 && /^\[/  { f=0 }
    f==1 && /=/    { print }
  '
}

# Compute the CLI-injected lines: local [source] entries whose key is ABSENT from
# the committed [source], or PRESENT there with a different value. If `.playbook`
# has no [source], or none was injected, INJECT_TMP is empty and reapply is a
# no-op (a plain, non-CLI install is left exactly as pulled).
if [ -f .playbook ]; then
  git show HEAD:.playbook 2>/dev/null | _source_body > "$INJECT_TMP.committed" || true
  _source_body < .playbook > "$INJECT_TMP.local"
  awk '
    function keyof(s,   k) { k=s; sub(/[[:space:]]*=.*/, "", k); gsub(/^[[:space:]]+|[[:space:]]+$/, "", k); return k }
    NR==FNR { k=keyof($0); if (k != "") { cval[k]=$0; seen[k]=1 } next }
    { k=keyof($0); if (k == "") next; if (!(k in seen) || cval[k] != $0) print }
  ' "$INJECT_TMP.committed" "$INJECT_TMP.local" > "$INJECT_TMP"
  rm -f "$INJECT_TMP.committed" "$INJECT_TMP.local"
fi

# reapply_source FILE — merge the CLI-injected key=value lines (INJECT_TMP) into
# FILE's [source] section: replace matching keys in place, append injected keys
# the section lacks, and create a [source] section if FILE has none. A no-op when
# nothing was injected.
reapply_source() {
  _pb="$1"
  [ -s "$INJECT_TMP" ] || return 0
  awk -v inj="$INJECT_TMP" '
    function keyof(s,   k) { k=s; sub(/[[:space:]]*=.*/, "", k); gsub(/^[[:space:]]+|[[:space:]]+$/, "", k); return k }
    BEGIN {
      n = 0
      while ((getline line < inj) > 0) {
        k = keyof(line)
        if (k != "" && !(k in val)) { val[k] = line; order[n++] = k }
      }
      close(inj)
    }
    /^\[source\]/ { insrc = 1; hadsrc = 1; print; next }
    insrc == 1 && /^\[/ {
      for (i = 0; i < n; i++) { k = order[i]; if (!(k in done)) print val[k] }
      insrc = 0; print; next
    }
    insrc == 1 {
      k = keyof($0)
      if (k != "" && (k in val)) { print val[k]; done[k] = 1; next }
      print; next
    }
    { print }
    END {
      if (insrc == 1) {
        for (i = 0; i < n; i++) { k = order[i]; if (!(k in done)) print val[k] }
      } else if (hadsrc != 1) {
        print ""; print "[source]"
        for (i = 0; i < n; i++) print val[order[i]]
      }
    }
  ' "$_pb" > "$_pb.tmp"
  mv "$_pb.tmp" "$_pb"
}

# Clean `.playbook` so the fast-forward has no local modification to trip over.
git checkout -- .playbook 2>/dev/null || true

echo "update-playbook: pulling latest LifeOS playbook (fast-forward only)..."
if ! git pull --ff-only; then
  echo "update-playbook: fast-forward pull failed; restoring injected .playbook metadata and aborting." >&2
  reapply_source .playbook
  exit 1
fi

# Merge the CLI-injected [source] keys onto the freshly pulled manifest: upstream's
# own [source] edits are kept, only the CLI-owned keys (branch, overriding
# repository) are re-injected. If the pulled manifest has no [source], one is
# created from the injected keys; if nothing was injected, this is a no-op.
reapply_source .playbook

# Case-insensitive filesystems (macOS/Windows): pulling a commit that removes a
# case-twin path (e.g. App/ alongside app/) also deletes the surviving file
# from disk, because both tracked paths point at the same physical file. Any
# tracked file the pull left missing from the working tree is restored here.
# GIT_LITERAL_PATHSPECS: file lists must be literal paths, not globs — payload
# paths contain glob metacharacters (e.g. app/file/[slug]/page.tsx).
if [ -n "$(git ls-files --deleted)" ]; then
  echo "update-playbook: restoring files dropped by case-collision handling..."
  git ls-files --deleted -z \
    | GIT_LITERAL_PATHSPECS=1 git restore --pathspec-from-file=- --pathspec-file-nul
fi

echo "update-playbook: re-deploying LifeOS runtime (idempotent overlay)..."
bun bin/deploy.ts --apply

echo "update-playbook: done. Restart the lifeos session to reload settings and hooks."
