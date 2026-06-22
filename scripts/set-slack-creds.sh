#!/bin/bash
#
# set-slack-creds.sh — write your 3 Slack values into .env and restart the bot.
#
#   ./scripts/set-slack-creds.sh <SLACK_BOT_TOKEN> <SLACK_APP_TOKEN> <SLACK_OWNER_USER_ID> [SLACK_USER_TOKEN]
#   e.g. ./scripts/set-slack-creds.sh xoxb-123… xapp-1-… U0123456789 xoxp-123…
#
# Get these from api.slack.com/apps: Bot User OAuth Token (xoxb-), App-Level Token (xapp-),
# and your member ID (Slack profile → ⋯ → Copy member ID). The optional 4th value is the
# User OAuth Token (xoxp-) — enables read-as-you (SearchMessages / ReadChannelMessages).

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="$REPO_ROOT/.env"

if [ $# -lt 3 ] || [ $# -gt 4 ]; then
  echo "Usage: $0 <xoxb-bot-token> <xapp-app-token> <U-member-id> [xoxp-user-token]" >&2
  exit 1
fi
BOT="$1"; APP="$2"; OWNER="$3"; USER_TOKEN="${4:-}"

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
if [ -n "$USER_TOKEN" ]; then
  set_kv SLACK_USER_TOKEN "$USER_TOKEN"
  echo "✓ Wrote Slack credentials (incl. user token) to .env"
else
  echo "✓ Wrote Slack credentials to .env"
fi

# Restart every service that reads .env at startup. The bot needs the tokens to connect;
# the management-api caches SLACK_BOT_TOKEN in process.env for its onboarding readiness
# check, so it too must reload or it will keep reporting a stale invalid_auth.
restarted=""
for svc in bot management runtime; do
  if launchctl kickstart -k "gui/$(id -u)/com.slackbot.$svc" >/dev/null 2>&1; then
    restarted="$restarted $svc"
  fi
done
if [ -n "$restarted" ]; then
  echo "✓ Restarting to pick them up:$restarted"
else
  echo "! Could not restart services (are they installed? run ./scripts/bootstrap.sh)."
fi
echo "Verify in the dashboard → Onboarding tab → Slack app → Re-check."
