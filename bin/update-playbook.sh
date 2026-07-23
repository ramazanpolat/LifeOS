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

# Preserve the CLI-injected [source] metadata across the pull. The
# claude-playbook CLI writes source fields (notably `branch = "..."`, plus the
# install-time repository) into the tracked `.playbook` at install time, so
# `.playbook` always shows as locally modified. A plain `git pull --ff-only`
# then REFUSES whenever the incoming commit ALSO touches `.playbook` — e.g. an
# upstream version bump — with "Your local changes to .playbook would be
# overwritten by merge". To stay update-safe:
#   1. save the local [source] section (CLI-owned metadata, never payload),
#   2. restore `.playbook` to its committed form so the fast-forward is clean,
#   3. pull (now unobstructed — the upstream version bump lands),
#   4. re-apply the saved [source] onto the freshly pulled manifest.
# Pure POSIX sh + awk (no python).

# Capture the local [source] block: from the `[source]` header to the next
# section header (or EOF).
SRC_BLOCK=""
if [ -f .playbook ] && grep -q '^\[source\]' .playbook; then
  SRC_BLOCK=$(awk '
    /^\[source\]/ { f=1 }
    f==1 && /^\[/ && $0 !~ /^\[source\]/ { f=0 }
    f==1 { print }
  ' .playbook)
fi

# reapply_source FILE — strip any existing [source] section from FILE, then
# re-append the saved SRC_BLOCK (keeps upstream's version + our injected source).
# A no-op when nothing was injected. Trailing blank lines are trimmed first so
# repeated updates never accumulate blank lines.
reapply_source() {
  _pb="$1"
  [ -n "$SRC_BLOCK" ] || return 0
  awk '
    /^\[source\]/ { skip=1 }
    skip==1 && /^\[/ && $0 !~ /^\[source\]/ { skip=0 }
    skip!=1 { print }
  ' "$_pb" > "$_pb.tmp"
  awk '{ lines[n++]=$0 } END { last=n; while (last>0 && lines[last-1]=="") last--; for (i=0;i<last;i++) print lines[i] }' "$_pb.tmp" > "$_pb.tmp2"
  { cat "$_pb.tmp2"; printf '\n'; printf '%s\n' "$SRC_BLOCK"; } > "$_pb"
  rm -f "$_pb.tmp" "$_pb.tmp2"
}

# Clean `.playbook` so the fast-forward has no local modification to trip over.
git checkout -- .playbook 2>/dev/null || true

echo "update-playbook: pulling latest LifeOS playbook (fast-forward only)..."
if ! git pull --ff-only; then
  echo "update-playbook: fast-forward pull failed; restoring injected .playbook metadata and aborting." >&2
  reapply_source .playbook
  exit 1
fi

# Re-apply the CLI-injected [source] onto the pulled manifest (upstream version +
# our branch/source). If the manifest shape is unexpected the awk strip is a
# no-op and this degrades to a plain append of the saved block.
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
