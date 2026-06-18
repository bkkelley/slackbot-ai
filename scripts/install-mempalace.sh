#!/bin/bash
#
# install-mempalace.sh — turn on optional long-term memory in one command.
#
#   ./scripts/install-mempalace.sh
#
# Installs the MemPalace CLI (local, offline, no API key), indexes your workspaces +
# Claude session transcripts, sets MEMORY_ENABLED=true, and restarts the bot + runtime.
# Idempotent — safe to re-run. To turn memory OFF later, use the toggle in the dashboard
# Onboarding tab (or set MEMORY_ENABLED=false in .env and restart bot + runtime).

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="$REPO_ROOT/.env"

# 1. Install the CLI (prefer uv, fall back to pipx, then pip --user)
if ! command -v mempalace >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/mempalace" ]; then
  echo "▶ Installing MemPalace…"
  if command -v uv >/dev/null 2>&1; then uv tool install mempalace
  elif command -v pipx >/dev/null 2>&1; then pipx install mempalace
  else python3 -m pip install --user mempalace; fi
fi
MEM="$(command -v mempalace || echo "$HOME/.local/bin/mempalace")"
[ -x "$MEM" ] || { echo "! MemPalace install failed — install uv (https://docs.astral.sh/uv) or pipx and re-run." >&2; exit 1; }
echo "✓ MemPalace installed: $("$MEM" --version 2>/dev/null || echo present)"

# 2. Index content (first run downloads a ~300MB embedding model; idempotent thereafter).
# Only the curated workspaces — NOT ~/.claude/projects (stale/cross-client session history).
echo "▶ Indexing workspaces (first run is slow)…"
"$MEM" mine "$HOME/claude-workspaces" >/dev/null 2>&1 || true
echo "✓ Indexed. ($("$MEM" status 2>/dev/null | grep -ci drawers || echo 0) rooms filed)"

# 3. Enable + restart consumers
if [ -f "$ENV" ]; then
  if grep -qE '^MEMORY_ENABLED=' "$ENV"; then sed -i '' -E 's|^MEMORY_ENABLED=.*|MEMORY_ENABLED=true|' "$ENV"
  else printf 'MEMORY_ENABLED=true\n' >> "$ENV"; fi
  echo "✓ MEMORY_ENABLED=true"
  for s in bot runtime; do launchctl kickstart -k "gui/$(id -u)/com.slackbot.$s" >/dev/null 2>&1 || true; done
  echo "✓ Bot + runtime restarting. Memory is on."
else
  echo "! No .env — run ./scripts/bootstrap.sh first, then re-run this."
fi
echo "Verify: mempalace search \"something you indexed\""
