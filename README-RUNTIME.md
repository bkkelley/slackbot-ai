# Agent Runtime System

A unified TypeScript daemon that runs AI agents on a schedule or on demand, routes their output to Slack (and optionally Discord), and writes structured cards to the vault. Replaces a previous system of Node.js subprocess spawning and text-output parsing.

---

## Architecture overview

```
                  ┌─────────────────────────────────┐
                  │         agent-runtime            │
                  │  (port 3457, 127.0.0.1 only)     │
                  │                                 │
                  │  Scheduler → Job Queue           │
                  │  Executor → Claude (subprocess)  │
                  │  IPC Server ← MCP Server         │
                  │  HTTP API + WebSocket stream     │
                  └────────────┬────────────────────┘
                               │ transport-proxy HTTP calls
                  ┌────────────▼────────────────────┐
                  │          slack-bot               │
                  │  (port 3458, 127.0.0.1 only)     │
                  │                                 │
                  │  Slack transport (bolt)          │
                  │  Discord transport (discord.js)  │
                  │  Runtime API surface             │
                  └─────────────────────────────────┘
                               │
                  ┌────────────▼────────────────────┐
                  │        management-api            │
                  │  (port 3456, 0.0.0.0)            │
                  │  Web UI + API proxies            │
                  └─────────────────────────────────┘
```

All three services run as macOS LaunchAgents (`com.slackbot.runtime`, `com.slackbot.bot`, `com.slackbot.management`).

---

## agent-runtime (`system/agent-runtime/`)

### What it does

- Maintains a durable SQLite job queue (`data/jobs.db`)
- Runs a built-in cron scheduler (reads `scheduler/jobs.json`, hot-reloads on each tick)
- Executes each job by spawning `claude --print --stream-json` with a per-job MCP server
- Assembles prompts from vault files (Agent profile, Action template, recent logs, tagged cards)
- Routes tool calls from Claude back through an IPC server
- Exposes an HTTP API and WebSocket stream for job management

### Directory layout

```
src/
  index.ts             — daemon entry, startup/shutdown
  types.ts             — AgentJob, JobResult, AgentJobTemplate, JobEvent
  job-queue.ts         — SQLite-backed queue + worker pool (MAX_CONCURRENT_JOBS=3)
  executor.ts          — spawns claude, streams NDJSON, manages timeout/abort
  context-assembler.ts — builds prompts from vault (Agent + Action + logs + cards + files)
  scheduler.ts         — cron runner, hot-reloads jobs.json every 60s
  ipc-server.ts        — HTTP server on ephemeral port, handles tool calls from MCP
  api.ts               — HTTP API on port 3457 + WebSocket upgrade handler
  websocket.ts         — WsManager: per-job subscriptions, emits JobEvents
  channel-router.ts    — normalises outputChannel refs
  agent-channels.ts    — reads/writes agent-channels.json (platform:id → agent mapping)
  logger.ts            — structured JSON logger
  mcp/
    server.ts          — stdio MCP server, one spawned per job; forwards calls to IPC
    tools/
      post-message.ts  — PostMessage({ text, channel?, threadId? })
      write-card.ts    — WriteCard({ yaml, content? })
      update-card.ts   — UpdateCard({ cardId, yaml, content? })
      spawn-agent.ts   — SpawnAgent({ agent, action, mode, ... })
      wait-for-job.ts  — WaitForJob({ jobId, timeoutSeconds? })
      get-job-status.ts — GetJobStatus({ jobId })
```

### HTTP API

All endpoints require `X-Bot-Auth: <BOT_RUNTIME_SHARED_SECRET>` header.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/jobs` | Submit a job. `mode: 'sync'` waits up to 5 min. |
| GET | `/api/jobs` | List jobs. Query: `status`, `limit`, `offset`. |
| GET | `/api/jobs/:id` | Get job by ID. |
| DELETE | `/api/jobs/:id` | Cancel a pending/running job. |
| POST | `/api/agents/:name/run` | Shorthand submit for a named agent. |
| GET | `/api/schedules` | List schedule templates from jobs.json. |
| POST | `/api/schedules` | Upsert a schedule template. |
| DELETE | `/api/schedules/:id` | Delete a schedule template. |
| GET | `/api/channels` | List agent-channels.json mappings. |
| PUT | `/api/channels/:platform/:channelId` | Map a channel to an agent. |
| DELETE | `/api/channels/:platform/:channelId` | Remove a mapping. |
| WS | `/api/jobs/:id/stream` | Stream job events in real time. |

### WebSocket events

```json
{ "type": "status", "status": "running" }
{ "type": "tool",   "tool": "PostMessage", "input": { ... } }
{ "type": "text",   "text": "..." }
{ "type": "done",   "status": "done", "result": { ... } }
```

### Job schema

```typescript
{
  agent?: string;          // loads Agent/<name>.md from vault
  action?: string;         // loads _agent_actions/<agent>-<action>.md from vault
  prompt?: string;         // raw prompt, skips vault assembly
  mode: 'sync' | 'async';
  toolset: 'default' | 'extended';
  outputChannel?: { platform: string; id: string };
  threadId?: string;
  files?: string[];        // absolute paths injected into prompt
  replyText?: string;      // appended as user reply in prompt
  sessionId?: string;      // enables session continuation
  parentJobId?: string;
}
```

### MCP tools available to Claude

| Tool | What it does |
|------|-------------|
| `PostMessage` | Posts a message to the job's output channel via bot transport-proxy |
| `WriteCard` | Writes a markdown card to `global/Card/`, records cardId in SQLite |
| `UpdateCard` | Updates an existing card by cardId |
| `SpawnAgent` | Spawns a child job (sync runs inline; async queues normally) |
| `WaitForJob` | Blocks until a job completes (max 600s, with priority boost for children) |
| `GetJobStatus` | Returns current status of any job |

### Concurrency model

- Worker pool: 3 concurrent jobs by default
- `SpawnAgent(sync)`: child runs inline on the parent's worker slot — no deadlock possible
- `SpawnAgent(async)`: child queued normally; `WaitForJob` has mandatory timeout

### Schedule templates (`scheduler/jobs.json`)

Two job types coexist in the same file:

- **Agent jobs**: `agent` + `action` fields → submitted to job queue
- **Shell jobs**: `command` field → spawned directly via bash

```json
{
  "id": "sage-morning-nudge",
  "cron": "0 8 * * *",
  "agent": "Sage",
  "action": "Morning Nudge",
  "mode": "async",
  "toolset": "default",
  "outputChannel": { "platform": "slack", "id": "C0B46F2KJHK" },
  "enabled": true
}
```

Active schedules:

| ID | Cron | Type |
|----|------|------|
| `sage-morning-nudge` | `0 8 * * *` | Agent |
| `inbox-processor` | `*/15 * * * *` | Shell (`run-inbox-processor.sh`) |
| `extract-ppao` | `0 11 * * *` | Shell |
| `extract-projects` | `0 11 * * *` | Shell |
| `extract-sources` | `0 11 * * *` | Shell |
| `extract-tags` | `0 11 * * *` | Shell |
| `obsidian-backup` | `0 0 * * *` | Shell |

---

## slack-bot (`system/slack-bot/`)

### What changed

The bot was refactored from a monolithic Slack-specific handler into a platform-agnostic pipeline with per-platform adapters. The core pipeline is in `src/orchestration/`; platform-specific code lives in `src/channels/`.

### Orchestration layer (`src/orchestration/`)

```
types.ts              — ChannelTransport, ChannelFormatter, IncomingMessage, ToolEvent
message-processor.ts  — main pipeline: receives IncomingMessage, runs Claude, streams back
tool-normalizer.ts    — maps raw claude tool_use blocks → typed ToolEvent
session-manager.ts    — session keys: <platform>:<channelId>:t=<threadId> etc.
working-dir-manager.ts — per-session working directories
mcp-manager.ts        — MCP server config assembly
rate-limiter.ts       — per-channel rate limiting
todo-manager.ts       — TodoWrite/TodoRead rendering
model-manager.ts      — per-session model override (haiku/sonnet/opus)
commands/             — /cwd, /mcp, /jobs, /model, /skills, /agents, /help
testing/
  fake-transport.ts   — in-memory ChannelTransport for tests
```

### Platform adapters

**Slack** (`src/channels/slack/`):
- `transport.ts` — wraps `@slack/bolt`, implements `ChannelTransport`
- `formatter.ts` — renders ToolEvents in Slack mrkdwn
- `file-downloader.ts` — downloads via `SLACK_BOT_TOKEN`
- `permission-provider.ts` — wraps PermissionIpcServer; bypass for default-toolset, prompt for extended

**Discord** (`src/channels/discord/`):
- `transport.ts` — wraps `discord.js` v14, implements `ChannelTransport`
- `formatter.ts` — renders ToolEvents in Discord markdown
- `file-downloader.ts` — fetch from Discord CDN (no auth needed)

Discord starts only if `DISCORD_BOT_TOKEN` is set in the environment.

### Runtime API surface (`src/runtime-api/`)

An Express HTTP server on `BOT_HTTP_PORT` (default 3458) that the agent-runtime calls back through:

```
server.ts           — boots the server, auth middleware, registers transports
transport-proxy.ts  — POST /api/transport-proxy/send
                      POST /api/transport-proxy/upload
                      POST /api/transport-proxy/react
permission-config.ts — GET /api/permission-config?platform=&channelId=&...
```

Supports multiple platforms: the `platform` field in the request body routes to the correct registered transport.

---

## management-api (`system/management-api/`)

Web dashboard running at `http://localhost:3456/agents/`.

### Routes

| Mount | File | Proxies to |
|-------|------|-----------|
| `/agents/api/agents` | `routes/agents.js` | vault agent files |
| `/agents/api/jobs` | `routes/jobs.js` | runtime `/api/schedules` (schedule templates) |
| `/agents/api/queue` | `routes/queue.js` | runtime `/api/jobs` (live queue) |
| `/agents/api/dispatch` | `routes/dispatch.js` | runtime `/api/jobs` (submit) |
| `/agents/api/activity` | `routes/activity.js` | vault card files |
| `/agents/api/logs` | `routes/logs.js` | runtime.log, slackbot.log |
| `/agents/api/inbox` | `routes/inbox.js` | runtime `/api/agents/inbox-processor/run` |

### SSE stream proxy

Browsers can't reach `127.0.0.1:3457` directly. `GET /agents/api/queue/:id/stream` bridges the runtime WebSocket to a browser-consumable EventSource:

1. Checks job status — if already done/failed, sends terminal event immediately
2. Otherwise opens a WebSocket to `ws://127.0.0.1:3457/api/jobs/:id/stream`
3. Forwards every event as `data: <json>\n\n` SSE
4. Closes on `done` or `failed` event

### Web UI tabs

- **Jobs** — scheduled job templates (from `jobs.json`); run any agent job on demand; live stream output
- **Queue** — live SQLite job queue; watch active jobs; auto-refreshes every 8s
- **Agents** — list and inspect agent vault files
- **Activity** — recent card files from vault
- **Logs** — tail runtime.log and slackbot.log
- **Inbox** — trigger inbox-processor

---

## What was retired

| Component | Replaced by |
|-----------|------------|
| `system/agent-dispatcher/agent-dispatcher.js` | agent-runtime executor + MCP tools |
| `system/scheduler/runner.js` | agent-runtime built-in scheduler |
| `com.slackbot.runtime` LaunchAgent | agent-runtime LaunchAgent |
| `SLACK_MESSAGE:` output directive | `PostMessage` MCP tool |
| `AGENT_LOG_CARD:` output directive | `WriteCard` MCP tool |
| `SPAWN_AGENT:` / `SPAWN_CALLBACK:` directives | `SpawnAgent` MCP tool |
| `sage-sessions.json` / `sage-agent-threads.json` | `sessionId` + `threadId` in `jobs.db` |
| `sage-followup-daemon` scheduler entry | removed (Sage sessions are stateless) |

---

## Environment variables

### agent-runtime (`system/agent-runtime/.env` or LaunchAgent plist)

| Variable | Default | Description |
|----------|---------|-------------|
| `RUNTIME_HTTP_PORT` | `3457` | HTTP API + WebSocket port |
| `BOT_HTTP_PORT` | `3458` | Bot's transport-proxy port |
| `BOT_RUNTIME_SHARED_SECRET` | — | Shared auth token for all internal API calls |

### slack-bot (`system/slack-bot/.env`)

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | `xoxb-...` |
| `SLACK_APP_TOKEN` | `xapp-...` |
| `SLACK_SIGNING_SECRET` | — |
| `BOT_HTTP_PORT` | Transport-proxy listen port (default 3458) |
| `BOT_RUNTIME_SHARED_SECRET` | Must match runtime |
| `DISCORD_BOT_TOKEN` | Optional — enables Discord adapter if set |

---

## Adding a new agent schedule

1. Add an entry to `system/scheduler/jobs.json`
2. POST it to the live runtime (no restart needed):

```bash
curl -s -X POST http://127.0.0.1:3457/api/schedules \
  -H "Content-Type: application/json" \
  -H "X-Bot-Auth: $BOT_RUNTIME_SHARED_SECRET" \
  -d '{
    "id": "my-agent-daily",
    "cron": "0 9 * * *",
    "agent": "MyAgent",
    "action": "Daily Task",
    "mode": "async",
    "toolset": "default",
    "enabled": true
  }'
```

## Submitting a one-off job

```bash
curl -s -X POST http://127.0.0.1:3457/api/agents/Sage/run \
  -H "Content-Type: application/json" \
  -H "X-Bot-Auth: $BOT_RUNTIME_SHARED_SECRET" \
  -d '{"action":"Morning Nudge","mode":"async","toolset":"default"}'
```

## Watching a job stream

```bash
# via management-api (works from any browser or remote machine)
curl -sN "http://localhost:3456/agents/api/queue/<jobId>/stream"

# direct WebSocket (local only)
websocat "ws://127.0.0.1:3457/api/jobs/<jobId>/stream" \
  -H "X-Bot-Auth: $BOT_RUNTIME_SHARED_SECRET"
```
