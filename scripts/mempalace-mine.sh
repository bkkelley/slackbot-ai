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

# Mine ONLY the curated workspaces (vault cards, notes, project files). We intentionally do
# NOT mine ~/.claude/projects (all Claude Code session transcripts): that pulls in obsolete
# history (e.g. the old crew system) and mixes every client's context together, which led the
# bot to answer from stale memory. Keep memory scoped to current, curated work.
echo "[mempalace-mine] mining workspaces…"
"$MEM" mine "$HOME/claude-workspaces" 2>&1 | tail -3 || true

echo "[mempalace-mine] done."
