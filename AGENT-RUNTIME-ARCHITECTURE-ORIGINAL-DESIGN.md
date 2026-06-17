# Agent Runtime Architecture

## Goal

Replace the current split between `agent-dispatcher.js` and `sync-job-runner.js` with a single,
unified agent execution engine. Agents are triggered manually or on a schedule, run with full
tool access including spawning subagents, and communicate entirely through tools rather than
parsed output strings.

## Decisions

- **Tools replace parsed output**: agents call `PostMessage`, `WriteCard`, `SpawnAgent` etc. as
  tools instead of writing `SLACK_MESSAGE:` / `AGENT_LOG_CARD:` / `SPAWN_AGENT:` in their output.
- **Unified runtime daemon**: one long-running process owns the job queue, executes jobs, and
  manages concurrency — replacing both agent-dispatcher and the scheduler runner.
- **MCP server per job**: each running Claude process gets its own stdio MCP server injected via
  `--mcp-config`, which exposes the agent tools. The MCP server communicates back to the runtime
  via an HTTP IPC socket (same pattern as the existing permission IPC server).
- **Sync and async subagents**: `SpawnAgent(mode: "sync")` blocks the parent until the child
  returns its result. `SpawnAgent(mode: "async")` queues the child and returns a job ID immediately.
- **Channel-agnostic**: agents specify a logical output channel; the runtime resolves it through
  the channel adapter layer (Slack, Discord, etc.).
- **IPC servers stay separate**: the runtime IPC server (agent tool callbacks) and the bot's
  permission IPC server (tool approval flow) are owned by different processes and kept independent.
- **WriteCard supports updates**: `WriteCard` returns a `cardId`. Agents can call `UpdateCard(cardId, yaml)`
  mid-run to revise a card in progress. Useful for long-running agents that want to log incrementally.
- **Agent-channel mapping in a config file**: `agent-channels.json` maps channel IDs (across all
  platforms) to agent names. Managed via the runtime API and UI — no env vars, no restart needed.
- **WebSocket streaming from the start**: the runtime streams live Claude output to the management
  UI via WebSocket. Each job has a dedicated stream endpoint; the UI subscribes on job start.

---

## What goes away

| Current | Replaced by |
|---|---|
| `agent-dispatcher.js` | `agent-runtime/executor.ts` |
| `scheduler/runner.js` | `agent-runtime/scheduler.ts` |
| `sync-job-runner.js` | same executor (sync mode is just a job option) |
| `SLACK_MESSAGE:` output parsing | `PostMessage` tool |
| `AGENT_LOG_CARD:` output parsing | `WriteCard` tool |
| `SPAWN_AGENT:` / `SPAWN_CALLBACK:` directives | `SpawnAgent` / `WaitForJob` tools |

---

## Directory structure

```
system/
  agent-runtime/              # new
    src/
      index.ts                # daemon entry point — starts all subsystems
      job-queue.ts            # in-memory queue + persistence to jobs-state.json
      executor.ts             # spawns Claude per job, manages timeout/abort
      context-assembler.ts    # builds agent prompts (vault cards, pillar, action template)
      channel-router.ts       # resolves channel IDs to the right adapter
      scheduler.ts            # cron + one-time job scheduling (replaces scheduler/runner.js)
      api.ts                  # HTTP API for job submission and status queries
      ipc-server.ts           # HTTP IPC endpoint — receives tool calls from MCP servers
      mcp/
        server.ts             # stdio MCP server, one instance per running job
        tools/
          post-message.ts
          write-card.ts
          update-card.ts
          spawn-agent.ts
          wait-for-job.ts
          get-job-status.ts

  agent-dispatcher/           # deprecated — remove after migration
  scheduler/                  # deprecated — remove after migration
  management-api/             # kept for web UI; extended with runtime API routes
  slack-bot/                  # updated to submit jobs via runtime API instead of subprocess
```

---

## Job definition

Every job requires either `agent` + `action` (vault-based) or `prompt` (raw) — not both.
Vault context assembly is optional; the runtime is general-purpose.

```typescript
interface AgentJob {
  // identity
  id: string;                          // uuid

  // prompt source — one of these two is required
  agent?: string;                      // vault-based: loads Agent/<name>.md
  action?: string;                     // vault-based: loads _agent_actions/<agent>-<action>.md
  prompt?: string;                     // raw: skip vault assembly, use this prompt directly

  // execution
  mode: 'sync' | 'async';
  toolset: 'default' | 'extended';     // see Tool access section
  status: 'pending' | 'running' | 'done' | 'failed';

  // triggering
  trigger: 'manual' | 'schedule' | 'spawn';
  parentJobId?: string;                // set when spawned by another agent

  // output routing
  outputChannel?: string;              // platform channel ID
  threadId?: string;                   // post as thread reply

  // context injection (vault-based jobs only)
  files?: string[];                    // file paths to inject into prompt
  replyText?: string;                  // injected as === USER'S REPLY ===
  sessionId?: string;                  // for multi-turn check-ins

  // scheduling (for job templates in jobs.json)
  cron?: string;
  runAt?: string;                      // ISO timestamp for one-time jobs

  // results (populated on completion)
  result?: {
    ok: boolean;
    error?: string;
    postedMessageIds: string[];        // message IDs from PostMessage calls
    cardFiles: string[];               // filenames from WriteCard calls
    childJobIds: string[];             // IDs of spawned children
  };

  // timing
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  lastRun?: string;                    // updated on each cron fire
}
```

### Context assembly

`context-assembler.ts` resolves the prompt for a job:

```
if job.prompt → use it directly
if job.agent + job.action → assemble from vault:
    load Agent/<agent>.md
    load Pillar/<domain>.md
    load _agent_actions/<agent>-<action>.md
    load recent agent log cards (14 days)
    load active patterns
    load tagged cards (pillar tag, 7 days)
    inject files, replyText, sessionId if present
```

Both paths produce the same thing: a string passed to Claude stdin. Everything downstream
(executor, MCP tools, job tracking, WebSocket streaming) is identical regardless of which
path produced the prompt.

---

## Agent MCP tools

These tools are exposed to every running agent via the injected MCP server.

### PostMessage

Post a message to a channel. Can be called multiple times during a run.

```typescript
input: {
  text: string;
  channel?: string;    // defaults to job's outputChannel
  threadId?: string;   // defaults to job's threadId
}
output: {
  ok: boolean;
  messageId?: string;
}
```

### WriteCard

Write an agent log card to the vault. Returns a `cardId` that can be passed to `UpdateCard`
to revise the card later in the same run.

```typescript
input: {
  yaml: string;        // card frontmatter fields (card-type, agent, etc.)
  content?: string;    // optional card body below the frontmatter
}
output: {
  ok: boolean;
  cardId?: string;     // opaque ID for use with UpdateCard
  cardFile?: string;   // filename written to vault
}
```

### UpdateCard

Overwrite an existing card written earlier in the same job. Useful for long-running agents
that want to log progress incrementally rather than writing one card at the very end.

```typescript
input: {
  cardId: string;      // returned by a previous WriteCard call
  yaml: string;        // replacement frontmatter
  content?: string;    // replacement body
}
output: {
  ok: boolean;
  cardFile?: string;
}
```

### SpawnAgent

Spawn a child agent job, either synchronously (wait for result) or asynchronously (fire and forget).

```typescript
input: {
  // vault-based
  agent?: string;
  action?: string;
  // raw prompt
  prompt?: string;
  // one of the above pairs is required
  mode: 'sync' | 'async';
  files?: string[];
  replyText?: string;
  outputChannel?: string;  // defaults to parent's outputChannel
  threadId?: string;       // defaults to parent's threadId
  toolset?: 'default' | 'extended';
}

// sync mode response — returned after child completes
output: {
  ok: boolean;
  error?: string;
  postedMessageIds: string[];
  cardFiles: string[];
  childJobIds: string[];
}

// async mode response — returned immediately
output: {
  ok: boolean;
  jobId: string;
}
```

### WaitForJob

Wait for a previously spawned async job to complete. Returns the same result shape as sync SpawnAgent.

```typescript
input: {
  jobId: string;
  timeoutSeconds?: number;   // default 600
}
output: {
  ok: boolean;
  timedOut?: boolean;
  error?: string;
  postedMessageIds: string[];
  cardFiles: string[];
  childJobIds: string[];
}
```

### GetJobStatus

Non-blocking status check.

```typescript
input:  { jobId: string }
output: { status: 'pending' | 'running' | 'done' | 'failed'; result?: JobResult }
```

---

## Tool access

Configured per-job via `toolset`. Agents can request extended access in their action template
frontmatter (`toolset: extended`).

| Tool | Default | Extended |
|---|---|---|
| PostMessage | ✓ | ✓ |
| WriteCard, UpdateCard | ✓ | ✓ |
| SpawnAgent | ✓ | ✓ |
| WaitForJob | ✓ | ✓ |
| GetJobStatus | ✓ | ✓ |
| Read, Grep, Glob | ✓ | ✓ |
| Skill | ✓ | ✓ |
| WebSearch | ✓ | ✓ |
| Task | — | ✓ |
| Write, Edit | — | ✓ |
| Bash | — | ✓ |

---

## Runtime architecture

### Daemon process

The runtime starts as a LaunchAgent and owns:
- **Job queue** — in-memory, persisted to `jobs-state.json` on every mutation
- **Worker pool** — configurable concurrency limit (default: 3 parallel jobs)
- **IPC server** — HTTP on a random localhost port, receives tool calls from MCP servers
- **HTTP API** — fixed port (e.g. 3457), accepts job submissions from bot + management UI
- **WebSocket server** — same port as HTTP API (`ws://localhost:3457`), streams live job output
- **Scheduler** — checks cron expressions every 60s, submits due jobs to the queue

### Executor flow (one job)

```
queue.next()
  → context-assembler builds prompt (agent + pillar + action + recent cards + patterns)
  → ipc-server allocates a job slot, notes port
  → spawn agent-mcp-server (stdio) with IPC port in env
  → spawn claude --print --stream-json --mcp-config <server config> --allowed-tools ...
  → write prompt to claude stdin
  → stream claude output (no parsing — tools handle all side effects)
  → on claude exit: mark job done/failed, release worker slot
  → notify any WaitForJob callers
```

### IPC flow (MCP tool → runtime)

```
Claude calls PostMessage(text, channel)
  → MCP server receives tool call
  → HTTP POST to ipc-server: { jobId, tool: "PostMessage", input: { text, channel } }
  → ipc-server resolves channel via channel-router
  → calls adapter.send(channelId, threadId, text)
  → returns { ok, messageId } to MCP server
  → MCP server returns tool result to Claude
```

SpawnAgent(sync) adds a child job to the queue and the IPC request stays open (long-poll)
until the child completes. SpawnAgent(async) returns the jobId immediately.

### Concurrency and deadlock prevention

Sync subagents are prioritized in the queue to prevent deadlock (parent holds a worker slot
waiting for a child that's stuck behind other jobs). The worker pool effectively has a reserved
lane for sync children: `max_concurrent_jobs + max_spawn_depth` slots are allocated, ensuring
a parent-child chain can always make progress.

---

## Job lifecycle

```
submit (API, scheduler, or SpawnAgent)
  → status: pending, added to queue

worker picks up job
  → status: running, startedAt recorded

Claude process exits 0
  → status: done, result populated, completedAt recorded
  → WaitForJob callers notified

Claude exits non-0 or times out
  → status: failed, error recorded
  → WaitForJob callers notified with error
```

---

## HTTP API (runtime)

Extends the management API. The management API web UI talks to these endpoints.

```
POST   /api/jobs                  submit a job
GET    /api/jobs                  list jobs (with filter/pagination)
GET    /api/jobs/:id              get job status + result
DELETE /api/jobs/:id              cancel a pending or running job

GET    /api/schedules             list scheduled job templates
POST   /api/schedules             create/update a schedule
DELETE /api/schedules/:id         remove a schedule

POST   /api/agents/:name/run      shorthand — submit a job for a named agent + action

GET    /api/channels              list agent-channel mappings
PUT    /api/channels/:channelId   set which agent owns a channel
DELETE /api/channels/:channelId   remove a channel mapping
```

## WebSocket streaming

The management UI subscribes to live job output via WebSocket. Each running job emits its
Claude NDJSON stream in real time so the UI can display tool calls, text output, and status
transitions as they happen — no polling.

```
WS ws://localhost:3457/api/jobs/:id/stream

Server → client message types:
  { type: 'output', line: <raw NDJSON line from claude> }
  { type: 'status', status: 'running' | 'done' | 'failed' }
  { type: 'tool',   tool: 'PostMessage' | 'WriteCard' | ..., input, output }
  { type: 'done',   result: JobResult }
```

The executor pipes Claude's stdout through the IPC server, which fans it out to all active
WebSocket subscribers for that job.

## Agent-channel mapping

Stored in `agent-channels.json` in the runtime config directory. Managed via the `/api/channels`
endpoints — no env vars, no restart needed to add or change a mapping.

```json
{
  "C08ABCDEF12": { "agent": "Sage", "platform": "slack" },
  "1234567890123456789": { "agent": "Sage", "platform": "discord" }
}
```

The runtime's `channel-router.ts` consults this file when resolving which agent to invoke for
an incoming message, and which channel to post to when a job runs without an explicit
`outputChannel`.

---

## Scheduler

Reads `jobs.json` (same file format as today, extended with `toolset` and `mode` fields).
Checks every 60s for due jobs and submits them to the queue via the internal job queue directly
(not HTTP — it's in-process).

One-time jobs (`runAt`) are disabled after firing (`enabled: false`), same as today.

---

## Bot integration

The Slack/Discord bot's `agent-handler` no longer spawns `agent-dispatcher.js` as a subprocess.
Instead:

```typescript
// async trigger (e.g. morning nudge reply, thread reply)
const { jobId } = await runtimeApi.submitJob({
  agent: 'Sage',
  action: 'Thread Reply',
  mode: 'async',
  outputChannel: slackChannelId,
  threadId: threadTs,
  replyText: userMessage,
});

// sync trigger (e.g. check-in — bot waits for first response before returning)
const result = await runtimeApi.submitJob({
  agent: 'Sage',
  action: 'Socratic Check-in',
  mode: 'sync',
  outputChannel: slackChannelId,
  threadId: ts,
  sessionId,
});
```

---

## Migration from current dispatcher

1. **Context assembly** — same logic, just moved to `context-assembler.ts`
2. **Agent prompts** — need updating: remove `SLACK_MESSAGE:` / `AGENT_LOG_CARD:` /
   `SPAWN_AGENT:` instructions, replace with tool usage instructions
3. **Action templates** — same structure, add optional `toolset: extended` frontmatter
4. **Scheduled jobs** — `jobs.json` gains `mode` and `toolset` fields; existing entries
   default to `mode: async` and `toolset: default`
5. **Slack bot** — `agent-handler.ts` switches from subprocess calls to runtime API calls
6. **Retirement** — once all agents are migrated and verified, delete `agent-dispatcher/`
   and `scheduler/`

---

