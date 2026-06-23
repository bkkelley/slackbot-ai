#!/bin/bash
#
# uninstall.sh — stop and remove the slackbot system: the three LaunchAgents, the code, the local
# workspace/vault/data tree, and the back-compat symlink. Backs up .env (your Slack tokens) first.
#
# Does NOT touch: your Slack app, the `sf` CLI orgs, the outlook skill, or ~/.mempalace
# (pass --memory to also remove the memory store).
#
#   ./scripts/uninstall.sh            # interactive confirm
#   ./scripts/uninstall.sh --yes      # no prompt
#   ./scripts/uninstall.sh --yes --memory   # also remove ~/.mempalace
#
# Run it from a NEW terminal — it deletes the directory your editor/session may be sitting in.

set -uo pipefail
cd "$HOME"   # never run from inside the tree we're about to delete

WS="$HOME/claude-workspaces"
SYMLINK="$HOME/Documents/claude-workspaces/slackbot-ai"
YES=false; MEMORY=false
for a in "$@"; do
  [ "$a" = "--yes" ] && YES=true
  [ "$a" = "--memory" ] && MEMORY=true
done

echo "This will remove:"
echo "  • LaunchAgents: com.slackbot.{runtime,bot,management}"
echo "  • $WS  (code, vault, workspaces, job queue)"
echo "  • $SYMLINK  (symlink only)"
$MEMORY && echo "  • $HOME/.mempalace  (memory store)"
echo "Your .env (Slack tokens) will be backed up first. Your Slack app is untouched."
echo
if [ "$YES" != true ]; then
  printf "Type 'yes' to proceed: "; read -r ans
  [ "$ans" = "yes" ] || { echo "Aborted."; exit 1; }
fi

# 1. Back up .env
if [ -f "$WS/system/.env" ]; then
  BACKUP="$HOME/slackbot-env-backup-$(date +%Y%m%d-%H%M%S).env"
  cp "$WS/system/.env" "$BACKUP" && chmod 600 "$BACKUP"
  echo "✓ Backed up .env → $BACKUP"
fi

# 2. Stop + remove the LaunchAgents
for svc in bot runtime management; do
  launchctl bootout "gui/$(id -u)/com.slackbot.$svc" >/dev/null 2>&1
  rm -f "$HOME/Library/LaunchAgents/com.slackbot.$svc.plist"
  echo "✓ removed com.slackbot.$svc"
done

# 3. Remove the code + data tree and the back-compat symlink
[ -L "$SYMLINK" ] && rm -f "$SYMLINK" && echo "✓ removed symlink $SYMLINK"
rm -rf "$WS" && echo "✓ removed $WS"

# 4. Optional: memory store
$MEMORY && { rm -rf "$HOME/.mempalace"; echo "✓ removed ~/.mempalace"; }

echo
echo "Uninstalled. Reinstall fresh from GitHub:"
echo "  git clone https://github.com/bkkelley/slackbot-ai.git ~/claude-workspaces/system"
echo "  cd ~/claude-workspaces/system"
echo "  cp ${BACKUP:-<your-env-backup>} .env     # restore tokens (reuse existing Slack app)"
echo "  ./scripts/bootstrap.sh"
