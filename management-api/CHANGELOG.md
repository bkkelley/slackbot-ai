# Changelog

All notable changes are documented here.

---

## 2026-05-25

### Added
- **Tools tab** — new tab in the web UI listing all available tools in three sections:
  1. Claude Code SDK tools, grouped by category (File & Code, Planning, Task Management, etc.)
  2. Agent-runtime MCP tools with descriptions and source file references
  3. External MCP servers read live from `slack-bot/mcp-servers.json`
- `routes/available-tools.js` — `GET /agents/api/available-tools` endpoint serving the above data
- `README.md` — initial component documentation
