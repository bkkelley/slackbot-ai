#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "Building..."
if ! npm run build 2>&1; then
  echo "Build failed — bot not restarted."
  exit 1
fi

echo "Build succeeded. Restarting bot..."
launchctl kickstart -k gui/$(id -u)/com.slackbot.bot
echo "Done."
