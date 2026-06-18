# System Stack

All automation services in `~/claude-workspaces/system/`. Single shared `.env` symlinked into each subsystem.

## Structure

```
system/
├── agent-runtime/          # Core runtime daemon (port 3457)
├── slack-bot/              # Slack + Discord transport bot (port 3458)
├── management-api/         # Web UI + API proxy (port 3456)
├── scheduler/              # jobs.json — schedule templates
├── shared/                 # vault.js, scaffold.js, config.js
└── scripts/                # obsidian-backup.sh
```

---

## Agent Runtime (`agent-runtime/`)

The core daemon. Runs agents on schedule or on demand, routes output to Slack/Discord, writes cards to the vault.

**Port:** `3457` (localhost only)

### How it works

1. Scheduler reads `jobs.json` every 60s, submits due jobs to the queue
2. Worker pool (3 concurrent) picks up jobs from the SQLite queue (`data/jobs.db`)
3. Executor spawns `claude --print --stream-json` with a per-job MCP server
4. Context assembler builds the prompt from vault files (Agent profile + Action template + recent cards + injected files)
5. Claude calls MCP tools during execution (PostMessage, WriteCard, SpawnAgent, RunSkill, etc.)
6. Results accumulate in SQLite; events stream via WebSocket

### Source layout

```
src/
├── index.ts               — daemon entry, startup/shutdown
├── types.ts               — AgentJob, JobResult, AgentJobTemplate, JobEvent
├── job-queue.ts           — SQLite-backed queue + worker pool
├── executor.ts            — spawns claude, streams NDJSON, manages timeout/abort
├── context-assembler.ts   — builds prompts from vault
├── scheduler.ts           — cron runner, hot-reloads jobs.json every 60s
├── ipc-server.ts          — HTTP on ephemeral port, handles MCP tool calls
├── api.ts                 — HTTP API on port 3457 + WebSocket upgrade
├── websocket.ts           — per-job subscriptions, emits JobEvents
├── channel-router.ts      — normalises outputChannel refs
├── agent-channels.ts      — reads/writes agent-channels.json
├── logger.ts              — structured JSON logger
└── mcp/
    ├── server.ts          — stdio MCP server, one per job
    └── tools/
        ├── post-message.ts   — PostMessage
        ├── write-card.ts     — WriteCard
        ├── update-card.ts    — UpdateCard
        ├── spawn-agent.ts    — SpawnAgent
        ├── wait-for-job.ts   — WaitForJob
        ├── get-job-status.ts — GetJobStatus
        └── run-skill.ts      — RunSkill
```

### MCP tools available to agents

| Tool | What it does |
|------|-------------|
| `PostMessage` | Posts a message to the job's output channel (Slack/Discord) |
| `WriteCard` | Writes a markdown card to `admin/Card/` |
| `UpdateCard` | Updates an existing card by cardId |
| `SpawnAgent` | Spawns a child job (sync runs inline; async queues normally) |
| `WaitForJob` | Blocks until an async job completes (max 600s) |
| `GetJobStatus` | Returns current status of any job |
| `RunSkill` | Runs a Claude Code skill by name (`~/.claude/commands/<skill>.md`) as a child job |
| `RunWorkflow` | Runs a named workflow from `admin/_workflows/<Name>.md` (sequential steps) |

### RunSkill

Agents can invoke any installed Claude Code skill mid-execution:

```
RunSkill({ skill: "frontend-design", args: "build a dashboard for...", mode: "sync" })
```

Looks up `~/.claude/skills/<skill>/SKILL.md`, reads the instructions, spawns a child job with that content as the prompt. `args` is appended after the skill content. Returns the child job result (sync) or job ID (async).

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

### Job schema

```typescript
{
  agent?: string;           // loads Agent/<name>.md from vault (global) or <workspace>/.agents/<name>.md (project)
  action?: string;          // loads action template from global or project scope based on scope field
  prompt?: string;          // raw prompt — skips vault assembly
  scope?: string;           // workspace name for project-scoped agents (omit for global)
  mode: 'sync' | 'async';
  toolset: 'default' | 'extended';
  outputChannel?: { platform: string; id: string };
  threadId?: string;
  files?: string[];         // absolute paths injected into prompt
  replyText?: string;       // appended as user reply in prompt
  sessionId?: string;       // enables session continuation
  parentJobId?: string;
}
```

### Concurrency

- Worker pool: 3 concurrent jobs
- `SpawnAgent(sync)`: child runs inline on parent's worker slot — no deadlock
- `SpawnAgent(async)`: child queued normally; use `WaitForJob` to block on it

### Common commands

```bash
# Submit a one-off job
curl -s -X POST http://127.0.0.1:3457/api/agents/Sage/run \
  -H "Content-Type: application/json" \
  -H "X-Bot-Auth: $BOT_RUNTIME_SHARED_SECRET" \
  -d '{"action":"Morning Nudge","mode":"async","toolset":"default"}'

# Add a schedule (no restart needed)
curl -s -X POST http://127.0.0.1:3457/api/schedules \
  -H "Content-Type: application/json" \
  -H "X-Bot-Auth: $BOT_RUNTIME_SHARED_SECRET" \
  -d '{"id":"my-agent-daily","cron":"0 9 * * *","agent":"MyAgent","action":"Daily Task","mode":"async","toolset":"default","enabled":true}'

# Watch a job stream
curl -sN "http://localhost:3456/agents/api/queue/<jobId>/stream"

# Logs
tail -f ~/claude-workspaces/system/agent-runtime/runtime.log
```

---

## Slack Bot (`slack-bot/`)

Platform-agnostic transport bot. Receives messages from Slack and Discord, runs them through Claude Code sessions, streams responses back.

**Port:** `3458` (localhost only — runtime calls back here for PostMessage/upload)

### Architecture

```
src/
├── orchestration/         — platform-agnostic pipeline
│   ├── message-processor.ts
│   ├── tool-normalizer.ts
│   ├── session-manager.ts
│   ├── working-dir-manager.ts
│   ├── mcp-manager.ts
│   ├── rate-limiter.ts
│   ├── todo-manager.ts
│   ├── model-manager.ts
│   └── commands/          — project, mcp, jobs, model, skills, agents, workflows, tasks, help
├── channels/
│   ├── slack/             — Slack transport (bolt), formatter, file-downloader
│   └── discord/           — Discord transport (discord.js v14), formatter, file-downloader
└── runtime-api/
    ├── server.ts          — Express on BOT_HTTP_PORT (3458)
    ├── transport-proxy.ts — POST /api/transport-proxy/send|upload|react
    └── permission-config.ts
```

Discord starts only if `DISCORD_BOT_TOKEN` is set.

### Slack commands

```
$agents list
$agents create
$agents delete <name>
$agents run <name> <action> [--files <path>]

model sonnet / haiku / opus / reset

$jobs
$jobs create
$jobs cancel <id>
$schedule <plain English>

$workflows list
$workflows run <name> [sync|async]
$workflows create
$workflows delete <name>

$tasks create <name>
$tasks add <listId> <task>
$tasks list <listId>

$project                 # show this channel's project mapping
$project map <name>      # map this channel to a project (Claude runs there)
$project unmap
$project list

mcp
mcp reload

$skills
$help
```

In a DM, start a message with `project: <name>` to scope that thread to a project.

### Model defaults

| Model | Best for |
|---|---|
| `haiku` _(default)_ | Questions, small edits, quick dispatch, explaining code |
| `sonnet` | Multi-file refactors, complex debugging, long agentic sessions |
| `opus` | Hardest tasks — use sparingly |

### Channel → project mapping (replaces "working directory")

There is no `cwd` command. Instead, a channel is **mapped to a project** = a workspace directory. When the bot is mentioned in a mapped channel it runs Claude Code **in that directory** and prepends a short "you're working on project X" context preamble.

- **Map** explicitly: `$project map <name>` in a channel, or the App Home **➕ Add / change a mapping** modal. `<name>` is a folder under `~/claude-workspaces/` (created on demand) or an absolute path.
- **Unmapped channels and DMs** fall back to the **`~/claude-workspaces/general/`** workspace. In a DM, a leading `project: <name>` line scopes that thread.
- Channel→project mappings live in `~/claude-workspaces/channel-projects.json` (gitignored). Managed by `slack-bot/src/orchestration/channel-projects.ts`. Multiple channels (e.g. a sales + a delivery channel) can map to the same project — both resolve to the same context.

#### Project bindings (`project.json` manifest)

Each project folder can carry a `~/claude-workspaces/<project>/project.json` that binds the project to the other systems a consulting engagement spans. It's folded into the context preamble, so a mapped channel auto-resolves all of them:

```json
{
  "name": "acme",
  "channels": ["C0AB…", "C0CD…"],
  "salesforce": { "org": "acme", "accountId": "001…", "projectId": "a0X…" },
  "drivePath": "/Users/…/Library/CloudStorage/GoogleDrive-…/My Drive/Clients/Acme"
}
```

- **Salesforce** — `$project sf <org> <AccountId> <Project__cId>` (or the Home modal). Claude queries these via the `sf` skill with `--target-org <org>` automatically — no need to name the org/records. (`Project__c` is the project object; Account is standard.) The salesforce skill is read-only by instruction (never writes CRM data).
- **Google Drive** — `$project drive <absolute path>`. The folder is a **Google Drive for Desktop** local synced path (`~/Library/CloudStorage/GoogleDrive-<acct>/…`), so Claude reads/writes it with normal file tools; dropping a file there syncs to the cloud. No API/OAuth.
- `$project` (no args) shows the project + its current bindings. Bindings are set manually (paste the 15/18-char Salesforce IDs); auto-discovery is a future enhancement.

### App Home tab

Owner-only (locked to `SLACK_OWNER_USER_ID`). Shows 📥 the last 10 Outlook inbox messages, 📅 upcoming calendar events (next 7 days), and the 📁 channel→project mappings (with Unmap buttons + an Add-mapping modal). A 🔄 Refresh button re-pulls Outlook. Outlook data comes from the `outlook` skill scripts at `~/.claude/skills/outlook/{mail.sh,cal.sh}` (Legacy Outlook only). Requires the **Home Tab** feature + `app_home_opened` event.

### HTML auto-publishing

When Claude writes a `.html` file during a session, the bot copies it to `~/server/html-outputs/` and posts a `${PUBLIC_BASE_URL}/previews/<file>` link in the thread.

### Auto-workspace creation

When a Slack channel is created, the bot automatically creates a matching workspace folder at `~/claude-workspaces/<channel-name>/` (including a `.agents/` subdirectory) via `POST http://localhost:3456/agents/api/projects`. Uses Socket Mode — no public URL needed. Requires `channel_created` in the Slack app's workspace event subscriptions.

### Editing the bot from Slack

1. Map a channel to the bot's source: `$project map /Users/.../slackbot-ai/slack-bot`
2. Ask Claude to make the change
3. `./deploy.sh` — builds first, only restarts on success

```bash
tail -f ~/claude-workspaces/system/slack-bot/bot.log
```

---

## Management API (`management-api/`)

Web dashboard at `http://localhost:3456/agents/`. Proxies to agent-runtime and vault.

**Port:** `3456`

### Routes

| Mount | Proxies to |
|-------|-----------|
| `/agents/api/agents` | vault + project agent files; `?scope=<workspace>` for project agents |
| `/agents/api/actions` | action templates; `?scope=<workspace>` for project templates |
| `/agents/api/workflows` | workflow files; `?scope=<workspace>` for project workflows |
| `/agents/api/personas` | persona files; `?scope=<workspace>` for project personas |
| `/agents/api/skills` | Claude Code skills; `/:scope/:name` for scoped access |
| `/agents/api/toolsets` | `agent-runtime/toolsets.json` |
| `/agents/api/projects` | list + create workspace directories |
| `/agents/api/available-tools` | static SDK tool list + agent-runtime tools + external MCP servers from `mcp-servers.json` |
| `/agents/api/jobs` | runtime `/api/schedules` (schedule templates) |
| `/agents/api/queue` | runtime `/api/jobs` (live queue) |
| `/agents/api/dispatch` | runtime `/api/jobs` (submit) |
| `/agents/api/activity` | vault card files |
| `/agents/api/logs` | runtime.log, slackbot.log |
| `/agents/api/inbox` | runtime `/api/agents/inbox-processor/run` |

### Web UI tabs

- **Activity** — recent cards from vault
- **Agents** — agents grouped by scope (Global + per-workspace); full CRUD + file editor + action templates
- **Jobs** — schedule templates; create/edit/delete; live queue with streaming output
- **Logs** — tail runtime.log and slackbot.log
- **Inbox** — trigger inbox-processor
- **Workflows** — workflows grouped by scope; edit, run, create, delete
- **Skills** — Claude Code skills grouped by scope (global + per-workspace)
- **Personas** — personas grouped by scope; edit, create, delete
- **Toolsets** — edit `toolsets.json` in-browser
- **Projects** — list all workspace directories with per-project resource counts; create new workspaces
- **Tools** — browse all available tools: Claude Code SDK tools by category, agent-runtime MCP tools with source file refs, external MCP servers from `mcp-servers.json`

```bash
launchctl kickstart -k gui/$(id -u)/com.slackbot.management
tail -f ~/claude-workspaces/system/management-api/server.log
```

---

## Scheduler (`scheduler/jobs.json`)

The runtime hot-reloads `jobs.json` every 60s. Two job types coexist:

- **Agent jobs**: `agent` + `action` → submitted to runtime queue
- **Shell jobs**: `command` → spawned directly via bash

**Active schedules:**

| ID | Cron | Type | What it does |
|----|------|------|-------------|
| `sage-morning-nudge` | `0 8 * * *` | Agent | Sage "Morning Nudge" |
| `inbox-processor` | `*/15 * * * *` | Shell | `run-inbox-processor.sh` |
| `extract-ppao` | `0 11 * * *` | Shell | Extracts PPAO → `ppao-files.json` |
| `extract-projects` | `0 11 * * *` | Shell | Extracts projects → `projects-files.json` |
| `extract-sources` | `0 11 * * *` | Shell | Extracts sources → `sources-files.json` |
| `extract-tags` | `0 11 * * *` | Shell | Extracts tags → `tags-files.json` |
| `obsidian-backup` | `0 0 * * *` | Shell | Git backup of `admin/` |
| `documentation-updater-nightly` | `0 1 * * *` | Agent | Documentation Updater "Nightly Scan" |

---

## Workflows

Named, declarative sequences of steps. Each step's output is passed to the next as `=== PRIOR STEP OUTPUT ===` context.

**Scope:**
- Global: `admin/_workflows/<Name>.md`
- Project: `<workspace>/.agents/workflows/<Name>.md`

**File format** (`admin/_workflows/<Name>.md` or `<workspace>/.agents/workflows/<Name>.md`):
```yaml
---
name: Morning Routine
steps:
  - type: agent
    agent: inbox-processor
    action: Process
  - type: agent
    agent: Sage
    action: Morning Nudge
  - type: skill
    skill: update-docs
    args: "optional extra context appended to skill prompt"
  - type: approval
    prompt: "Approve continuing to the next workflow step?"
    timeoutMinutes: 60
    onDeny: abort
    onTimeout: abort
  - type: workflow
    workflow: Some Other Workflow
    model: claude-haiku-4-5-20251001
outputChannel:
  platform: slack
  id: C0XXXXXXXXX
---
Description of what this workflow does.
```

**Step types:** `agent` (runs an agent action), `skill` (runs a skill from `~/.claude/commands/`), `workflow` (nested workflow), `approval` (pauses for an approve/deny decision in the management UI).

**Triggering:**
```bash
# Via API
curl -s -X POST http://127.0.0.1:3457/api/workflows/Morning%20Routine/run \
  -H "Content-Type: application/json" \
  -H "X-Bot-Auth: $BOT_RUNTIME_SHARED_SECRET" \
  -d '{"mode":"async"}'

# Via scheduler (jobs.json)
{ "id": "morning-routine", "cron": "0 8 * * *", "workflow": "Morning Routine", "mode": "async", "enabled": true }

# From within an agent via MCP tool
RunWorkflow({ workflow: "Morning Routine", mode: "sync" })
```

**Behavior:** Steps run sequentially. If any step fails, the workflow aborts and returns the error. All cards and messages from all steps are accumulated in the final result.

Runtime jobs bypass low-level tool permissions by default; use explicit `approval` steps for semantic checkpoints like publishing, deployment, deletion, or other human decisions.
If a workflow has an output channel, approval steps also send Slack approval buttons.

Completed job results include telemetry when available from Claude: cost, duration, token counts, model, tool calls, tools used, unused allowed tools, output size, and efficiency hints. Workflow results also include per-step metrics in `stepResults`.

**Available workflows:**
- `Morning Routine` — process inbox files, then run Sage's morning nudge with that context

---

## Toolsets (`agent-runtime/toolsets.json`)

Named sets of tools available to agents. Executor reads this file per job; falls back to hardcoded defaults if the file is missing.

| Toolset | Best for |
|---|---|
| `vault-readonly` | Read-only vault agents — no write, no web |
| `default` | Standard agents — read, web search, all MCP tools |
| `extended` | Full access — adds Write, Edit, Bash |
| `web` | Web research agents |
| `code` | Code-focused agents with file write access |

Set per-agent in `admin/Agent/<Name>.md` frontmatter (`toolset: extended`) or per-job in the API request.

To add a new toolset: edit `toolsets.json` — no code change or restart required.

---

## Personas

Reusable voice/tone/constraint definitions that compose into agents. Injected into the prompt before the agent's own instructions.

**Scope:**
- Global: `admin/_personas/<Name>.md`
- Project: `<workspace>/.agents/personas/<Name>.md`

To use: add `persona: [[PersonaName]]` to an agent's frontmatter. The context assembler reads the persona file and injects it as a `=== PERSONA ===` section.

If no `persona` field is set, behavior is unchanged.

**Available personas:**
- `Quiet Observer` — direct, warm, non-anxious; short responses; no greetings or sign-offs

---

## Shared Libraries (`shared/`)

| File | Exports | Used by |
|---|---|---|
| `vault.js` | `listAgents`, `getAgent`, `writeAgent`, `updateAgentFrontmatter`, `deleteAgentFile`, `projectAgentDir` | slack-bot, management-api |
| `scaffold.js` | `createAgent`, `deleteAgent` | slack-bot, management-api |
| `config.js` | `vaultPath`, `claudePath`, `baseDirectory`, `schedulerDir` | vault.js, scaffold.js |

`vault.js` is scope-aware: all functions accept an optional `scope` parameter (workspace name). `listAgents()` scans both `admin/Agent/` and all `<workspace>/.agents/` directories.

---

## Long-term memory (optional, MemPalace)

An **opt-in** local memory + recall layer ([MemPalace](https://github.com/mempalace/mempalace)). **Fully offline** — local embeddings, **no API key, no LLM**. The whole feature no-ops unless `MEMORY_ENABLED=true`; every call fails soft, so the system behaves identically when it's not installed.

**How memory is populated:** `mempalace mine` indexes content into a local "palace" (`~/.mempalace/palace`). A scheduled shell job (`mempalace-mine`, hourly) mines `~/claude-workspaces` (project files, vault cards, notes) and `~/.claude/projects` (Claude session transcripts, `--mode convos`). Script: `scripts/mempalace-mine.sh` (self-gates on `MEMORY_ENABLED`).

**Wiring (only when enabled):**
- **Bot** — auto-recalls relevant context into each prompt (`[Relevant memory]` preamble) via `mempalace search`, and gets MemPalace's tools through its native `mempalace-mcp` stdio server (registered in `claude-handler.ts`). Client: `slack-bot/src/orchestration/memory.ts`.
- **Agents** — `context-assembler.ts` injects a `=== RELEVANT MEMORY ===` section. Client: `agent-runtime/src/memory.ts`.
- **Onboarding** — an optional readiness check + an **Enable/Disable toggle** + a guided install entry in the Onboarding wizard (`POST /api/onboarding/memory/toggle` flips `MEMORY_ENABLED`).

**Recall path:** the clients shell out to `mempalace search "<query>" --results N` and parse the matched content (there is no REST API — MemPalace is CLI + MCP). Env: `MEMORY_ENABLED` (and optional `MEMPALACE_BIN` / `MEMPALACE_MCP_BIN`). Install steps: SETUP.md §6d.

---

## LaunchAgents

Plist files: `~/Library/LaunchAgents/`

| Label | What it runs |
|---|---|
| `com.slackbot.runtime` | Agent runtime daemon (always-on) — port 3457 |
| `com.slackbot.bot` | Slack/Discord bot (always-on) — port 3458 |
| `com.slackbot.management` | Management UI + API (always-on) — port 3456 |

```bash
launchctl list | grep com.slackbot
launchctl kickstart -k gui/$(id -u)/com.slackbot.<label>   # restart one

# Load / unload (modern bootstrap form)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.slackbot.<label>.plist
launchctl bootout gui/$(id -u)/com.slackbot.<label>
```

---

## Agents

| Agent | File | Slack channel | Trigger |
|---|---|---|---|
| Sage | `admin/Agent/Sage.md` | `#sage` (`C0XXXXXXXXX`) | Daily nudge (scheduler) |
| inbox-processor | `admin/Agent/inbox-processor.md` | — | Every 15 min (shell job) |
| Documentation Updater | `admin/Agent/Documentation Updater.md` | — | Nightly 1am UTC |
| example-orchestrator | `admin/Agent/example-orchestrator.md` | — | On demand |

---

## Agent pattern

Agents come in two scopes: **global** (vault-backed, long-lived) and **project** (workspace-local, tied to a codebase).

### Global agents

- `admin/Agent/<Name>.md` — vault file with frontmatter (`status`, `model`, `cadence`, `last-session`) + full instructions
- `claude-workspaces/<name>/CLAUDE.md` — Claude's entry point (one-liner pointer or full inline)
- `claude-workspaces/<name>/.claude/settings.json` — tool permissions

**Create via:** Slack (`$agents create`), web UI (scope = Global), or `scaffold.createAgent()`.

**What scaffold creates:**

| File | Purpose |
|---|---|
| `admin/Agent/<Name>.md` | Vault file with frontmatter shell |
| `claude-workspaces/<name>/CLAUDE.md` | One-liner pointer to vault file |
| `claude-workspaces/<name>/.claude/settings.json` | Default tool permissions |

### Project agents

Live entirely inside a workspace — no vault entry, no scaffold.

| File | Purpose |
|---|---|
| `<workspace>/.agents/<Name>.md` | Agent definition (same frontmatter format) |
| `<workspace>/.agents/actions/<Name> - <Action>.md` | Project-scoped action templates |
| `<workspace>/.agents/workflows/<Name>.md` | Project-scoped workflows |
| `<workspace>/.agents/personas/<Name>.md` | Project-scoped personas |
| `<workspace>/.agents/skills/<name>/SKILL.md` | Project-scoped Claude Code skills |

**Create via:** Web UI (Agents tab → New, choose scope dropdown).

**Run via API:** Include `"scope": "<workspace>"` in the job payload:
```bash
curl -s -X POST http://127.0.0.1:3457/api/jobs \
  -H "Content-Type: application/json" \
  -H "X-Bot-Auth: $BOT_RUNTIME_SHARED_SECRET" \
  -d '{"agent":"MyAgent","action":"Do Thing","scope":"main","mode":"async","toolset":"default"}'
```

### Common to both

**Agent output:** Agents use MCP tools (`PostMessage`, `WriteCard`) — no output directives required.

**Personas:** Set `persona: "[[PersonaName]]"` in frontmatter. Context assembler resolves from project scope first, then global.

**Action templates:** Define the prompt shape for each action. Global: `admin/_agent_actions/<AgentName> - <Action>.md`. Project: `<workspace>/.agents/actions/<AgentName> - <Action>.md`.

**Skills:** Agents can call `RunSkill({ skill: "skill-name" })` to execute any installed Claude Code skill mid-execution.

**Workflows:** Agents can call `RunWorkflow({ workflow: "workflow-name" })` to execute a named sequential workflow.

---

## Environment variables

### agent-runtime

| Variable | Default | Description |
|---|---|---|
| `RUNTIME_HTTP_PORT` | `3457` | HTTP API + WebSocket port |
| `BOT_HTTP_PORT` | `3458` | Bot's transport-proxy port |
| `BOT_RUNTIME_SHARED_SECRET` | — | Shared auth token for all internal API calls |

### slack-bot

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-...` |
| `SLACK_APP_TOKEN` | `xapp-...` |
| `SLACK_SIGNING_SECRET` | — |
| `BOT_HTTP_PORT` | Transport-proxy listen port (default 3458) |
| `BOT_RUNTIME_SHARED_SECRET` | Must match runtime |
| `DISCORD_BOT_TOKEN` | Optional — enables Discord adapter if set |
