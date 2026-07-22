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

echo "update-playbook: pulling latest LifeOS playbook (fast-forward only)..."
git pull --ff-only

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
