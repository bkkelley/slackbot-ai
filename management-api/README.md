# Management API

Web dashboard and API proxy for the agent system. Runs at port 3456 (localhost only).

**URL:** `http://localhost:3456/agents/`

## Stack

- **Backend:** Express.js (`server.js`) — no build step, runs directly with Node
- **Frontend:** Single-file Alpine.js SPA (`web/index.html`) — Tailwind via CDN, hash-based routing
- **Auth:** Optional shared token for API routes (`MANAGEMENT_API_TOKEN`)

## Routes

| Mount | What it does |
|---|---|
| `/agents/api/agents` | Agent CRUD + file editor (global + project-scoped) |
| `/agents/api/actions` | Action template CRUD |
| `/agents/api/workflows` | Workflow CRUD + run trigger |
| `/agents/api/skills` | Claude Code skill listing |
| `/agents/api/personas` | Persona CRUD |
| `/agents/api/toolsets` | Read/write `agent-runtime/toolsets.json` |
| `/agents/api/projects` | List + create workspace directories |
| `/agents/api/available-tools` | SDK tools list, agent-runtime MCP tools, external MCP servers |
| `/agents/api/jobs` | Proxies → runtime `/api/schedules` (schedule templates) |
| `/agents/api/queue` | Proxies → runtime `/api/jobs` (live queue) |
| `/agents/api/dispatch` | Proxies → runtime `/api/jobs` (submit) |
| `/agents/api/budgets` | Proxies → runtime budget policy, usage, and cost drift signals |
| `/agents/api/notifications` | Proxies → runtime interrupt policy with scoped notification rules |
| `/agents/api/evals` | Agent/action eval CRUD + sync runs |
| `/agents/api/activity` | Vault card files |
| `/agents/api/logs` | Tail runtime.log, slackbot.log |
| `/agents/api/inbox` | Trigger inbox-processor run |

## Tabs

| Tab | Description |
|---|---|
| Activity | Recent agent cards from the vault |
| Agents | Full CRUD + file editor, grouped by scope |
| Actions | Action template management |
| Jobs | Schedule templates + live queue with streaming output |
| Efficiency | Agent quality, budget caps, interrupt policy, and 7-day cost drift |
| Evals | Agent/action eval cases with pass/fail checks |
| Logs | Tail runtime.log and slackbot.log |
| Inbox | Trigger inbox-processor |
| Workflows | Workflow CRUD + run, grouped by scope |
| Skills | Claude Code skills grouped by scope |
| Personas | Persona CRUD grouped by scope |
| Toolsets | Edit `toolsets.json` in-browser |
| Projects | Workspace directory list with resource counts |
| Tools | Browse all available tools: SDK, agent-runtime MCP, external MCP servers |
| Guide | New agent creation walkthrough |

## Workflow templates

The Workflows tab's New modal can seed workflows from built-in templates:

- Blank
- Builder -> Reviewer Loop
- Code -> Test -> Fix
- Research -> Approval -> Publish
- Triage -> Route
- Evaluator Gate

Templates are plain workflow markdown. After creation they can be edited in Builder or YAML mode like any other workflow.

Template bodies include a Marker Contract section. Keep those exact markers in the relevant action output, for example `APPROVED`, `NEEDS_CHANGES`, `TESTS_PASS`, `TESTS_FAIL`, `PASS`, `FAIL`, `ROUTE:code`, `ROUTE:research`, `HANDLED`, or `BLOCKED`.

The workflow create route has a smoke test for custom template content:

```bash
npm run test:workflows
```

## Running

```bash
# Enable API auth in management-api/.env
MANAGEMENT_API_TOKEN=<your-long-random-token>

# Restart via LaunchAgent
launchctl kickstart -k gui/$(id -u)/com.slackbot.management

# Logs
tail -f ~/claude-workspaces/system/management-api/server.log
```

When `MANAGEMENT_API_TOKEN` is set, `/agents/api/*` returns `401` until the browser has the token. The UI prompts once, stores it locally in the browser, and sends it on later API and streaming requests.
