# Slackbot — New Features Plan

Plan to bring six capabilities into the slackbot system. Several are ports from the
`crew` system (a productized fork of this same codebase); the rest are net-new Slack-native
work or completion of existing plumbing.

> Status: **Phases 1–4 implemented; both subsystems compile clean** (`npm run build` passes in
> `slack-bot` and `agent-runtime` after `npm install`). Remaining work is Slack app-settings (scopes,
> Home Tab, events), a paid plan for Lists, and live testing. Google Drive (#6) deferred.

---

## Architecture: where features land

Every feature belongs to one of three layers. Naming the layer keeps the work clean.

| Layer | Path | Use for |
|---|---|---|
| **A. Slack transport** | `slack-bot/src/channels/slack/transport.ts` + new command classes in `slack-bot/src/orchestration/commands/` | Bot natively does Slack-native things (canvas, lists, scheduled messages, Home tab) |
| **B. Agent MCP tools** | `agent-runtime/src/mcp/tools/` | So Claude *agents* can call these mid-run (e.g. "write today's summary to a canvas") |
| **C. Claude Code skills** | `~/.claude/skills/<name>/` | Pure Bash/AppleScript capabilities (Outlook); reached via `RunSkill` |

**Command system:** each command is a class with `handle(ctx): Promise<boolean>`, chained in
`message-processor.ts` (~L157–163). Adding a command = new class + one line. Returning `true`
means "handled, stop the chain."

**Transport:** `SlackTransport` wraps a Bolt `app.client`, so Slack Web API calls are
`this.app.client.<method>`. Existing methods already cover `chat.postMessage`, `chat.update`,
`files.uploadV2`, `reactions.*`.

---

## Prerequisites to confirm before build

1. **Slack workspace plan tier** — Slack **Lists require a paid plan**. Confirm before Feature #4.
2. **`@slack/web-api` version** — Bolt `^4.4.0` pulls web-api v7.x. `canvases.*` is present;
   `slackLists.*` typings landed in **≥ 7.8**. Bump the dep, or call via
   `client.apiCall('slackLists.items.create', …)` as a fallback.
3. **Slack app manifest scopes** — several features need new bot scopes (listed per feature);
   adding scopes requires reinstalling the app to the workspace.

New bot scopes required across the plan:
`canvases:write`, `canvases:read`, `lists:write`, `lists:read`, `reminders:write`
(`chat:write` already present).

---

## Feature specs

### #1 — Legacy Outlook (mail + calendar) · Layer C · ✅ **DONE**

Ported `crew`'s skill. Pure AppleScript-over-Bash against the legacy Outlook for Mac app —
no Microsoft Graph, no OAuth app, no API keys.

- **Installed at:** `~/.claude/skills/outlook/` (`SKILL.md`, `mail.sh`, `cal.sh`). Resolver finds it
  as a global skill; harness registered it. Agents reach it via `RunSkill({ skill: "outlook" })`;
  the `extended` toolset already grants Bash.
- **Adaptation from crew:** `SKILL.md` script paths rewritten from relative `.claude/skills/outlook/…`
  to absolute `~/.claude/skills/outlook/…` so they work from any agent working directory (crew agents
  run from the vault root; slackbot agents don't).
- **Verified live:** `mode` → `legacy`; `accounts` → `<work-email>`; `calendars`
  enumerated (own + shared + second account). macOS Automation permission already granted.
- **Caveats (inherent, not code-fixable):** bot must run on the Mac signed into Outlook; Outlook
  in **Legacy** mode (New Outlook has no AppleScript); user logged in for scheduled jobs (GUI app).

### #2 — Claude Code from Slack · already existed; App Home tab ✅ **BUILT (needs build + setup + deploy)**

Base capability was already live (`claude-handler.ts`, `message-processor.ts`).

1. **App Home tab** — ✅ built. `buildHomeBlocks()` in `slack-bot/src/channels/slack/home-view.ts`
   (reads agents from the filesystem, schedules from the runtime `/api/schedules`, shows quick
   commands + dashboard link). Registered via an `app_home_opened` handler in `transport.ts`
   (guards `tab === 'home'`). **Setup:** enable the **Home Tab** under App Home in app settings +
   subscribe to the `app_home_opened` event.
2. **@mention private-preview gating** — _not built (lower value; can add later)._

### #3 / #3a — Create & manage agents / workflows / skills from Slack · Layer A · ✅ **BUILT (needs build + deploy)**

- `$agents` already had full CRUD; `$skills` already had list/add/remove (via the `skills` CLI).
  The gap was **workflows** — no Slack command at all.
- **Built:** new `$workflows` command (`slack-bot/src/orchestration/commands/workflows.ts`):
  - `$workflows list` — lists global (`VAULT_PATH/_workflows`) + per-workspace
    (`<ws>/.agents/workflows`) workflows with step counts.
  - `$workflows run <name> [sync|async]` — POSTs to runtime `/api/workflows/:name/run` with the
    current channel/thread as `outputChannel`, so results post back in-thread.
  - `$workflows create` — conversational authoring (name → description → add agent+action steps in
    a loop → `done`), writes the YAML+markdown workflow file. Reuses the `agents.ts`/`jobs.ts`
    session + agent/action-listing pattern.
  - `$workflows delete <name>` — deletes a global workflow file (path-guarded via
    `shared/path-guard`).
- **Wired:** imported + instantiated + added to the command-routing chain in `message-processor.ts`;
  added to `$help` and both CLAUDE.md command lists.
- **Note:** still needs `cd slack-bot && ./deploy.sh` to build + restart (not compile-verified here).
- **Deferred within 3a:** richer `$agents` editing (current CRUD is sufficient for now).

### #4 — Slack Lists (tracked tasks) · Layer A + B · ✅ **BUILT (needs build + scope add + PAID plan + live test)**

The home for **persistent, tracked tasks** (the Slack task-list feature).

- **Gating:** **requires a paid Slack plan.** `lists:write` + `lists:read` scopes.
- **Built (correct-by-docs, `apiCall` so version-proof):**
  - Transport: `createTaskList` (slackLists.create + reads primary column id), `addTask`
    (resolves primary column via slackLists.columns.list, encodes `rich_text`), `listTasks`
    (slackLists.items.list + best-effort rich_text → plain text).
  - Proxy: `/api/transport-proxy/task` (op = create-list / add / list).
  - Agent MCP tools: `CreateTaskList`, `AddTask`, `ListTasks` (`agent-runtime/.../manage-task.ts`),
    wired through ipc-server + mcp/server + toolsets.
  - Command: `$tasks create|add|list` (`slack-bot/.../commands/tasks.ts`) — **stateless**, operates
    on explicit list IDs (returned by create).
- **⚠️ Unverified:** the exact Lists field shapes (item field extraction, columns.list response
  key) are correct-by-docs but **not tested on a live paid workspace** — expect to iterate once a
  paid plan is available.
- **Future:** per-channel default-list mapping (so `$tasks add <text>` needs no list ID); a
  `CompleteTask` op (needs the checkbox column + slackLists.items.update).

### #4b — Reminders & time-based delivery · Layer A + scheduler · ✅ **BUILT (needs build + scope add + deploy)**

Three durable mechanisms; **intent picks the path**:

| Need | Mechanism | Scope | Durability |
|---|---|---|---|
| One-off future **message** ("ping me 3pm tomorrow") — **primary** | `chat.scheduleMessage` (+ `chat.scheduledMessages.list`, `chat.deleteScheduledMessage`) | `chat:write` (have it) | ✅ Core API, up to 120 days out |
| Native Slack **reminder** card (Slackbot ping) | `reminders.add` (bot token) | `reminders:write` | ⚠️ Works today, on retirement path, no replacement API |
| **Recurring** / system-driven | existing `jobs.json` cron scheduler | — | ✅ Fully ours |

- **`chat.scheduleMessage` is the default** for ad-hoc future messages — cleaner and more durable
  than scheduling a one-off runtime job just to post a message.
- **`reminders.add`** only when the user explicitly wants the native reminder UX. Do **not** make
  it the backbone of task management.
- **Recurring** stays on the cron scheduler.
- **Slack Workflow Builder is NOT used** — the bot cannot author Workflow-Builder workflows at
  runtime (they're code-defined/deployed; "Steps from Apps" is deprecated; modern automation is a
  separate Deno app model). Workflow creation/management lives in *our own* system via #3a.
- **Transport methods:** `scheduleMessage`, `listScheduledMessages`, `cancelScheduledMessage`,
  `addReminder`.
- **Effort:** Low.

### #5 — Canvases · Layer A + B · ✅ **BUILT (needs build + scope add + deploy)**

- **Scopes:** `canvases:write`, `canvases:read`.
- **Transport:** `createCanvas(title, markdown, channelId?)` + `editCanvas(canvasId, markdown)` via
  `conversations.canvases.create` (channel-tabbed — **works on free plans**) or `canvases.create`
  (standalone — paid). Uses `apiCall` (untyped) to build regardless of `@slack/web-api` version.
  `editCanvas` appends (insert_at_end).
- **Agent tool:** `WriteCanvas` (`agent-runtime/src/mcp/tools/write-canvas.ts`) — create, or append
  when `canvasId` given; defaults channel to the job output channel.
- **Effort:** Low.

### ✅ What was built for #5 + #4b (Phase 2)

Vertical slice across both subsystems. Build chain:
`MCP server (per job)` → `IPC server` → `tool impl` → `bot transport-proxy` → `SlackTransport`.

| File | Change |
|---|---|
| `slack-bot/src/orchestration/types.ts` | Added `CreatedCanvas`/`ScheduledMessage`/`ScheduledMessageSummary`/`CreatedReminder` + optional `ChannelTransport` methods (canvas/schedule/reminder) |
| `slack-bot/src/channels/slack/transport.ts` | Implemented `createCanvas`, `editCanvas`, `scheduleMessage`, `listScheduledMessages`, `cancelScheduledMessage`, `addReminder` |
| `slack-bot/src/runtime-api/server.ts` | Proxy endpoints: `/canvas`, `/schedule-message`, `/list-scheduled`, `/cancel-scheduled`, `/reminder` (each guards on transport support) |
| `agent-runtime/src/mcp/tools/transport-proxy.ts` | New shared `callTransportProxy()` helper |
| `agent-runtime/src/mcp/tools/write-canvas.ts` | `WriteCanvas` impl |
| `agent-runtime/src/mcp/tools/schedule-message.ts` | `ScheduleMessage` / `ListScheduledMessages` / `CancelScheduledMessage` impls |
| `agent-runtime/src/mcp/tools/add-reminder.ts` | `AddReminder` impl |
| `agent-runtime/src/ipc-server.ts` | Dispatch for the 5 new tools |
| `agent-runtime/src/mcp/server.ts` | Declared (ListTools) + routed (CallTool) the 5 new tools |
| `agent-runtime/toolsets.json` + `executor.ts` FALLBACK_TOOLSETS | Added the 5 tools to `default` + `extended` |

**New agent MCP tools:** `WriteCanvas`, `ScheduleMessage`, `ListScheduledMessages`,
`CancelScheduledMessage`, `AddReminder`.

**⚠️ Not yet done — required to go live:**
1. **Add Slack bot scopes** at api.slack.com → OAuth & Permissions, then **reinstall the app**:
   `canvases:write`, `canvases:read`, `reminders:write`. (`chat:write` already present, covers
   scheduled messages.)
2. **Build both subsystems** (no `node_modules` in this checkout, so changes are **not yet
   compile-verified**): `cd slack-bot && ./deploy.sh` (builds then restarts) and
   `cd agent-runtime && npm run build` then `launchctl kickstart -k gui/$(id -u)/com.slackbot.runtime`.
3. **Verify `@slack/web-api`** is recent enough for `chat.scheduleMessage`/`reminders.add` typings
   (v7.x from Bolt ^4.4 is fine; canvas uses `apiCall` so it's version-proof).

### #6 — Google Drive · **DEFERRED (out of scope this round)**

Reframe for later: the "Google Drive for Slack" app is end-user link unfurling, not a programmable
surface. Durable path is Drive directly via crew's `gws` CLI in a skill (Layer C). Not built now.

---

## Sequencing

1. **Phase 1 — free, high-value ports (no plan/scope friction):** #1 Outlook skill. Pure Layer C;
   immediate capability.
2. **Phase 2 — Slack-native, additive scopes:** #5 Canvases (free-plan-friendly), #4b time-based
   delivery (`chat.scheduleMessage` + `reminders.add`). Low risk, demos well.
3. **Phase 3 — finish Slack management:** #3a workflows/skills/agents commands (no new backend).
4. **Phase 4 — gated / heavier:** #4 Lists (needs paid plan confirmation), #2 App Home tab.

---

## Open questions

- [ ] Is the Slack workspace on a **paid** plan? (gates #4 Lists)
- [ ] Bump `@slack/web-api` to ≥ 7.8, or use `apiCall` fallback for `slackLists.*`?
- [ ] App Home tab content — which surfaces matter most (agents, schedules, activity, tasks)?
