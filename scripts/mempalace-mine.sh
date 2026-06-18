#!/bin/bash
# Mine the workspaces + Claude session transcripts into the MemPalace palace so the
# optional long-term memory stays current. Idempotent (mempalace skips already-filed files).
# Self-gates on MEMORY_ENABLED so it does nothing when the optional feature is off.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

ENABLED="false"
if [ -f "$ENV_FILE" ]; then
  ENABLED="$(grep -E '^MEMORY_ENABLED=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '[:space:]')"
fi
if [ "${ENABLED:-false}" != "true" ]; then
  echo "MEMORY_ENABLED is not true — skipping mine."
  exit 0
fi

MEM="${MEMPALACE_BIN:-$HOME/.local/bin/mempalace}"
if [ ! -x "$MEM" ]; then
  echo "mempalace CLI not found at $MEM — skipping mine."
  exit 0
fi

echo "[mempalace-mine] mining workspaces…"
"$MEM" mine "$HOME/claude-workspaces" 2>&1 | tail -3 || true

if [ -d "$HOME/.claude/projects" ]; then
  echo "[mempalace-mine] mining Claude session transcripts…"
  "$MEM" mine "$HOME/.claude/projects" --mode convos 2>&1 | tail -3 || true
fi

echo "[mempalace-mine] done."
