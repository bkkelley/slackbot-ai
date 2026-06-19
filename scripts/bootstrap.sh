#!/bin/bash
#
# bootstrap.sh — one-command setup for a fresh machine.
#
#   git clone … && cd slackbot-ai && ./scripts/bootstrap.sh
#
# Does every scriptable step: installs deps, builds, creates the workspace/vault dirs,
# scaffolds the shared .env (generated secret + placeholder Slack tokens) and symlinks it
# into each service, generates + loads the three LaunchAgents, and health-checks.
# Idempotent — safe to re-run. The only manual step left is creating the Slack app and
# pasting its 3 tokens (see the printed next-steps, or scripts/set-slack-creds.sh).

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
UID_NUM="$(id -u)"
LA_DIR="$HOME/Library/LaunchAgents"

say() { printf '\033[1;36m▶ %s\033[0m\n' "$1"; }
ok()  { printf '\033[1;32m✓ %s\033[0m\n' "$1"; }
warn(){ printf '\033[1;33m! %s\033[0m\n' "$1"; }

# ── 0. Prereqs ───────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || { warn "Node not found. Install Node ≥ 20 (brew install node) and re-run."; exit 1; }
command -v npm  >/dev/null 2>&1 || { warn "npm not found."; exit 1; }
NODE_BIN_DIR="$(dirname "$(command -v node)")"
PLIST_PATH="$NODE_BIN_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
say "Node: $(node -v) at $NODE_BIN_DIR"

# ── 1. Dependencies + build ──────────────────────────────────────────────────
say "Installing dependencies + building (this can take a minute)…"
( cd shared          && npm install --no-audit --no-fund >/dev/null 2>&1 ) && ok "shared deps"
( cd management-api  && npm install --no-audit --no-fund >/dev/null 2>&1 ) && ok "management-api deps"
( cd slack-bot       && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1 ) && ok "slack-bot built"
( cd agent-runtime   && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1 ) && ok "agent-runtime built"

# ── 2. Workspace + vault dirs ─────────────────────────────────────────────────
say "Creating workspace + vault directories…"
mkdir -p "$HOME/claude-workspaces/global/Agent" \
         "$HOME/claude-workspaces/global/Card" \
         "$HOME/claude-workspaces/global/_agent_actions" \
         "$HOME/claude-workspaces/global/_workflows" \
         "$HOME/claude-workspaces/global/_personas" \
         "$HOME/claude-workspaces/general" \
         "$REPO_ROOT/.local/logs" \
         "$REPO_ROOT/agent-runtime/data"
ok "directories ready"

# ── 3. Shared .env (scaffold if missing) + symlinks ───────────────────────────
if [ ! -f "$REPO_ROOT/.env" ]; then
  say "Scaffolding .env (placeholder Slack tokens + generated secret)…"
  cat > "$REPO_ROOT/.env" <<EOF
# ── Slack app (fill these in — see scripts/set-slack-creds.sh) ──
SLACK_BOT_TOKEN=xoxb-REPLACE_ME
SLACK_APP_TOKEN=xapp-REPLACE_ME
SLACK_OWNER_USER_ID=U-REPLACE_ME

# ── Internal auth (generated) ──
BOT_RUNTIME_SHARED_SECRET=$(openssl rand -hex 24)

# ── Ports (localhost) ──
MANAGEMENT_PORT=3456
RUNTIME_HTTP_PORT=3457
BOT_HTTP_PORT=3458
MANAGEMENT_BIND_HOST=127.0.0.1
PUBLIC_BASE_URL=http://localhost:3456
EOF
  chmod 600 "$REPO_ROOT/.env"
  ok ".env created (set your Slack tokens next)"
else
  ok ".env already present — leaving it untouched"
fi
for s in slack-bot agent-runtime management-api; do ln -sf ../.env "$REPO_ROOT/$s/.env"; done
ok ".env symlinked into each service"

# ── 4. LaunchAgents (generate + load) ─────────────────────────────────────────
say "Installing the three LaunchAgents…"
mkdir -p "$LA_DIR"
make_plist() {  # $1=label suffix  $2=service dir
  local label="com.slackbot.$1" dir="$REPO_ROOT/$2"
  cat > "$LA_DIR/$label.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>WorkingDirectory</key><string>$dir</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string><string>exec npm start</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$PLIST_PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$REPO_ROOT/.local/logs/$label.out.log</string>
  <key>StandardErrorPath</key><string>$REPO_ROOT/.local/logs/$label.err.log</string>
</dict>
</plist>
EOF
  # bootout is async — pause before re-bootstrapping so they don't race (which leaves it unloaded).
  launchctl bootout "gui/$UID_NUM/$label" >/dev/null 2>&1 || true
  sleep 1
  launchctl bootstrap "gui/$UID_NUM" "$LA_DIR/$label.plist" >/dev/null 2>&1 || true
  launchctl enable "gui/$UID_NUM/$label" >/dev/null 2>&1 || true
  launchctl kickstart "gui/$UID_NUM/$label" >/dev/null 2>&1 || true
}
make_plist runtime    agent-runtime
make_plist management management-api
make_plist bot        slack-bot
ok "LaunchAgents installed + loaded (runtime, management, bot)"

# ── 5. Health check (retry — services cold-start via tsx, can take ~10-20s) ─────
say "Waiting for services to come up…"
SECRET="$(grep '^BOT_RUNTIME_SHARED_SECRET=' "$REPO_ROOT/.env" | cut -d= -f2-)"
code() { curl -s -o /dev/null -w "%{http_code}" "$@" 2>/dev/null; }
RT=000; MG=000; BO=000
for i in $(seq 1 12); do
  sleep 3
  RT=$(code -H "X-Bot-Auth: $SECRET" http://127.0.0.1:3457/api/jobs)
  MG=$(code http://127.0.0.1:3456/agents/)
  BO=$(code http://127.0.0.1:3458/)
  [ "$RT" = "200" ] && [ "$MG" = "200" ] && { [ "$BO" = "401" ] || [ "$BO" = "200" ]; } && break
done
printf '  runtime    %s\n  management %s\n  bot        %s  (401 = up; auth enforced)\n' "$RT" "$MG" "$BO"

echo
if grep -q 'REPLACE_ME' "$REPO_ROOT/.env"; then
  warn "Almost there — finish the Slack app, then set your tokens:"
  echo "    1) Create the app:  https://api.slack.com/apps → Create New App → From a manifest"
  echo "       Paste: slack-bot/slack-app-manifest.yaml"
  echo "    2) Install to Workspace, then set the 3 tokens:"
  echo "       ./scripts/set-slack-creds.sh xoxb-… xapp-… U-yourMemberId"
  echo "    3) Open the dashboard → Onboarding tab:  http://localhost:3456/agents/#onboarding"
else
  ok "Setup complete. Dashboard → http://localhost:3456/agents/#onboarding"
fi
