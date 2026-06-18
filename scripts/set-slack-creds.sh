#!/bin/bash
#
# set-slack-creds.sh — write your 3 Slack values into .env and restart the bot.
#
#   ./scripts/set-slack-creds.sh <SLACK_BOT_TOKEN> <SLACK_APP_TOKEN> <SLACK_OWNER_USER_ID>
#   e.g. ./scripts/set-slack-creds.sh xoxb-123… xapp-1-… U0123456789
#
# Get these from api.slack.com/apps: Bot User OAuth Token (xoxb-), App-Level Token (xapp-),
# and your member ID (Slack profile → ⋯ → Copy member ID).

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="$REPO_ROOT/.env"

if [ $# -ne 3 ]; then
  echo "Usage: $0 <xoxb-bot-token> <xapp-app-token> <U-member-id>" >&2
  exit 1
fi
BOT="$1"; APP="$2"; OWNER="$3"

[ -f "$ENV" ] || { echo "No .env found — run ./scripts/bootstrap.sh first." >&2; exit 1; }

set_kv() {  # key value
  local key="$1" val="$2"
  if grep -qE "^$key=" "$ENV"; then
    # in-place replace (BSD/macOS sed)
    sed -i '' -E "s|^$key=.*|$key=$val|" "$ENV"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV"
  fi
}
set_kv SLACK_BOT_TOKEN "$BOT"
set_kv SLACK_APP_TOKEN "$APP"
set_kv SLACK_OWNER_USER_ID "$OWNER"
echo "✓ Wrote Slack credentials to .env"

launchctl kickstart -k "gui/$(id -u)/com.slackbot.bot" >/dev/null 2>&1 && echo "✓ Bot restarting to pick them up." || echo "! Could not restart the bot (is it installed? run ./scripts/bootstrap.sh)."
echo "Verify in the dashboard → Onboarding tab → Slack app → Re-check."
