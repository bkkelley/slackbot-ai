# Agent Runtime

Core execution daemon for the agent automation system. Runs agents on schedule or on demand, routes output to Slack/Discord, and writes cards to the vault.

**Port:** `3457` (localhost only)  
**Log:** `~/claude-workspaces/system/agent-runtime/runtime.log`  
**LaunchAgent:** `com.slackbot.runtime`

---

## How it works

1. Scheduler reads `jobs.json` every 60s, submits due jobs to the queue
2. Worker pool (3 concurrent) picks up jobs from the SQLite queue (`data/jobs.db`)
3. Executor spawns `claude --print --stream-json` with a per-job MCP server
4. Context assembler builds the prompt from vault files (Agent profile + Action template + recent cards + injected files)
5. Claude calls MCP tools during execution (`PostMessage`, `SpawnAgent`, `RunSkill`, etc.)
6. Results accumulate in SQLite; events stream via WebSocket
7. Terminal result metadata records cost, duration, tokens, model, tool usage, and efficiency hints

---

## Scoping

Jobs can be **global** (vault-backed) or **project-scoped** (workspace-local). Set `scope: "<workspace-name>"` on a job to activate project scope.

When a job has a scope, the runtime resolves all resources project-first, falling back to global:

| Resource | Project path | Global fallback |
|---|---|---|
| Agent | `<workspace>/.claude/agents/<Name>.md` | `~/.claude/agents/<Name>.md` |
| Action template | `<workspace>/.agents/actions/<Action>.md` with `agents:` metadata | `~/.agents/actions/<Action>.md` |
| Persona | `<workspace>/.agents/personas/<Name>.md` | `~/.agents/personas/<Name>.md` |
| Skill | `<workspace>/.claude/skills/<name>/SKILL.md` | `~/.claude/skills/<name>/SKILL.md` |
| Agent skill | `<workspace>/.claude/agents/<Agent>/skills/<name>/SKILL.md` | `~/.claude/agents/<Agent>/skills/<name>/SKILL.md` |
| Workflow | `<workspace>/.agents/workflows/<Name>.md` | `global/_workflows/` |
| MCP servers | `<workspace>/.claude/settings.json` (merges with global) | `~/.claude/settings.json` |

**Scope inheritance:** child jobs spawned via `RunSkill`, `RunWorkflow`, or `SpawnAgent` automatically inherit the parent job's scope.

Agent resolution reads `<workspace>/.claude/agents/<Name>.md` first, then legacy `<workspace>/.agents/<Name>.md`, then global `~/.claude/agents/<Name>.md`, then legacy `global/Agent/<Name>.md`. Skill resolution has three layers: agent-specific first, then workspace-specific, then global. Legacy project skills under `<workspace>/.agents/skills/<name>/SKILL.md` are still read as a compatibility fallback, but new workspace skills are written to `<workspace>/.claude/skills/<name>/SKILL.md`.

---

## MCP servers

Each job gets a fresh per-job MCP server with the `agent-tools` set. Additional MCP servers are loaded from:

1. `~/.claude/settings.json` (global)
2. `<workspace>/.claude/settings.json` (project — overrides global on name conflict)

All loaded server tool patterns (`mcp__<serverName>__*`) are automatically added to `--allowed-tools`.

To add project-scoped MCP servers (e.g. Supabase, Vercel), create `<workspace>/.claude/settings.json`:

```json
{
  "mcpServers": {
    "supabase": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@supabase/mcp-server-supabase@latest", "--access-token", "<pat>"],
      "env": { "SUPABASE_PROJECT_REF": "abc123" }
    }
  }
}
```

---

## MCP tools available to agents

| Tool | What it does |
|---|---|
| `PostMessage` | Posts to the job's output channel (Slack/Discord) |
| `SpawnAgent` | Spawns a child job (sync runs inline; async queues normally) |
| `WaitForJob` | Blocks until an async job completes (max 600s) |
| `GetJobStatus` | Returns current status of any job |
| `RunSkill` | Runs a project- or global-scoped Claude Code skill |
| `RunWorkflow` | Runs a named workflow sequentially |

---

## Workflow approvals

Runtime jobs still run with bypassed tool permissions by default. Add human review only where the workflow itself needs a decision:

```yaml
steps:
  - type: agent
    agent: Researcher
    action: Draft Brief
  - type: approval
    prompt: "Approve posting this brief?"
    timeoutMinutes: 60
    onDeny: abort
    onTimeout: abort
  - type: agent
    agent: Publisher
    action: Post Brief
    model: claude-haiku-4-5-20251001
```

Pending approvals appear in the management UI's Approvals tab and are available through `/api/approvals`.
If the workflow has an output channel, the runtime also posts Slack approval buttons for Slack channels.

## Adaptive workflow control

Agent, skill, and nested-workflow steps can opt into lightweight control flow:

| Field | What it does |
|---|---|
| `maxAttempts` | Retries the same step until it succeeds or reaches the limit. |
| `successWhen` | Overrides success detection: `job_ok`, `output_includes`, or `output_excludes`. |
| `successText` | Text marker used by `output_includes` / `output_excludes`. |
| `runIf` | Gates a step: `always`, `previous_succeeded`, `previous_failed`, `previous_output_includes`, `previous_output_excludes`. |
| `runIfText` | Text marker used by output-based `runIf` gates. |
| `onFailure` | `abort` or `continue` after retries are exhausted. |
| `jumpOnSuccess` | 1-based step number to run next after success. |
| `jumpOnFailure` | 1-based step number to run next after failure. |
| `maxVisits` | Maximum times a step may be visited by jumps; defaults to 3. |

Simple retry:

```yaml
steps:
  - type: agent
    agent: Builder
    action: Fix Tests
    toolset: code
    maxAttempts: 3
```

Evaluator loop:

```yaml
steps:
  - type: agent
    agent: Builder
    action: Draft Change
    toolset: code
    maxVisits: 3
  - type: agent
    agent: Reviewer
    action: Review Change
    successWhen: output_includes
    successText: APPROVED
    jumpOnFailure: 1
    maxVisits: 3
```

A full checked-in example lives at `agent-runtime/examples/workflows/AdaptiveReviewLoop.md`.
Copy it into `global/_workflows/AdaptiveReviewLoop.md` for a global workflow, or into `<workspace>/.agents/workflows/AdaptiveReviewLoop.md` for a project-scoped workflow.

When the reviewer output does not include `APPROVED`, the runtime marks the review step failed, feeds that output into the next Builder visit as workflow context, and jumps back to step 1 until the review passes or `maxVisits` is exceeded.

Preview jobs include per-step control-flow notes for adaptive fields, such as retry counts, output markers, jump targets, run conditions, and visit limits. Preview validation also flags risky loops such as self-jumps without explicit `maxVisits`.

### Marker conventions

Marker-based workflow steps should use a small, exact vocabulary so adaptive checks remain reliable:

| Marker | Use |
|---|---|
| `APPROVED` | Reviewer accepts the work and the loop may continue. |
| `NEEDS_CHANGES` | Reviewer wants another producer pass. Include concrete feedback after the marker. |
| `BLOCKED` | The agent cannot complete or evaluate because context, access, or inputs are missing. |
| `TESTS_PASS` | Verification passed. |
| `TESTS_FAIL` | Verification failed. Include failing command/output after the marker. |
| `PASS` | Generic evaluator acceptance. |
| `FAIL` | Generic evaluator rejection. Include feedback after the marker. |
| `ROUTE:code` | Triage selected the coding path. |
| `ROUTE:research` | Triage selected the research path. |
| `HANDLED` | A routed handler completed its work. |

When a workflow step uses `successText` or `runIfText`, mention that exact marker in the action template or the workflow body's Marker Contract section. Preview warns when it cannot find the marker in either place.

---

## Runtime telemetry

Completed job results include execution metadata when Claude reports it:

- `durationMs`, `apiDurationMs`, `totalCostUsd`
- `inputTokens`, `outputTokens`, cache token counts, `totalTokens`
- `model`, `toolCallCount`, `toolsUsed`, `unusedAllowedTools`
- `outputChars`, `efficiencyHints`

Workflow jobs aggregate child step metrics and store per-step `stepResults`, so the management UI can show which pipeline stages are slow, expensive, low-output, or candidates for a narrower toolset.

The runtime marks the SQLite database with `PRAGMA user_version = 2` after ensuring the `approval_requests` table and indexes exist.

---

## Toolsets

Named sets of allowed tools, defined in `toolsets.json`. Toolsets are global — no project-scoped overrides.

| Toolset | Includes |
|---|---|
| `vault-readonly` | Read, Grep, Glob, PostMessage, GetJobStatus |
| `default` | + WebSearch, SpawnAgent, WaitForJob, RunSkill, RunWorkflow |
| `extended` | + Write, Edit, Bash |
| `web` | Read, Grep, Glob, WebSearch, WebFetch, PostMessage, GetJobStatus |
| `code` | Read, Grep, Glob, Write, Edit, Bash, PostMessage, GetJobStatus |

---

## Common commands

```bash
# Submit a one-off job
curl -s -X POST http://127.0.0.1:3457/api/agents/Sage/run \
  -H "Content-Type: application/json" \
  -H "X-Bot-Auth: $BOT_RUNTIME_SHARED_SECRET" \
  -d '{"action":"Morning Nudge","mode":"async","toolset":"default"}'

# Submit a project-scoped job
curl -s -X POST http://127.0.0.1:3457/api/jobs \
  -H "Content-Type: application/json" \
  -H "X-Bot-Auth: $BOT_RUNTIME_SHARED_SECRET" \
  -d '{"agent":"MyAgent","action":"Do Thing","scope":"my-website","mode":"async","toolset":"extended"}'

# Restart
launchctl kickstart -k gui/$(id -u)/com.slackbot.runtime

# Logs
tail -f ~/claude-workspaces/system/agent-runtime/runtime.log
```
