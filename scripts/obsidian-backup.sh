#!/bin/bash
set -euo pipefail

# All paths/remote are env-overridable so nothing is hardcoded to a user.
SOURCE="${VAULT_PATH:-$HOME/claude-workspaces/admin}"
MIRROR="${OBSIDIAN_BACKUP_MIRROR:-$HOME/claude-workspaces/admin-git-backup}"
REMOTE="${OBSIDIAN_BACKUP_REMOTE:-}"
BRANCH="${OBSIDIAN_BACKUP_BRANCH:-main}"

if [ -z "$REMOTE" ]; then
  echo "OBSIDIAN_BACKUP_REMOTE not set — skipping backup." >&2
  exit 0
fi

if [ ! -d "$SOURCE" ]; then
  echo "Vault source not found: $SOURCE" >&2
  exit 1
fi

if [ ! -d "$MIRROR/.git" ]; then
  if [ -e "$MIRROR" ] && [ "$(ls -A "$MIRROR" 2>/dev/null)" ]; then
    echo "Mirror path exists but is not a git repo: $MIRROR" >&2
    exit 1
  fi
  git clone --branch "$BRANCH" "$REMOTE" "$MIRROR"
fi

git -C "$MIRROR" fetch origin "$BRANCH"
git -C "$MIRROR" checkout "$BRANCH"
git -C "$MIRROR" pull --rebase origin "$BRANCH"

rsync -a --delete \
  --exclude '.git/' \
  --exclude '.DS_Store' \
  --exclude '.obsidian/workspace' \
  --exclude '.obsidian/workspace.json' \
  --exclude '.obsidian/workspace-mobile.json' \
  --exclude '.trash/' \
  "$SOURCE"/ "$MIRROR"/

git -C "$MIRROR" add -A
if git -C "$MIRROR" diff --cached --quiet; then
  echo "No vault changes to back up."
  exit 0
fi

git -C "$MIRROR" commit -m "Auto-backup $(date '+%Y-%m-%d %H:%M')"
git -C "$MIRROR" push origin "$BRANCH"
