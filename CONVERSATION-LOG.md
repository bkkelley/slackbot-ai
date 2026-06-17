# Conversation Log — Slackbot Feature Build

> A transcript reconstruction of the working session that scanned the project for secrets,
> compared it against the `crew` system, planned six new features, and implemented Phases 1–4.
> Saved 2026-06-16.

---

## 1. "Are there any secrets or sensitive information in this directory?"

**Scan result:** No live secrets. Findings:

- No real `.env` files — only `.env.example` templates with placeholders (`xoxb-your-bot-token`, `your-anthropic-api-key`, `change-me`).
- No tokens/keys/PEM private keys hardcoded in source; all values come from `process.env`.
- No runtime state present (`*.log`, sqlite DBs, `mcp-servers.json`, `agent-channels.json`).
- `.gitignore` correctly excludes `.env`, `data/`, `mcp-servers.json`, logs, etc.
- **Minor exposures (not secrets):** Tailscale hostname `<tailscale-host>` hardcoded in several source files + READMEs (internal-network only, low risk; candidate for an env var). Three `.DS_Store` files (leak filenames; gitignored).

**Bottom line:** Nothing would expose an API key/token/password. Only genuinely sensitive item is the internal Tailscale hostname baked into source.

---

## 2. "Compare this directory to ~/crew and tell me the differences"

Two generations of the same system. `slackbot` = original dev workspace; `crew` = a later **productized fork** (installers, integrations, compiled-vault architecture). Shared subsystems exist in both but the code has **fully diverged** (every common runtime file differs).

| | `slackbot` | `crew` |
|---|---|---|
| Identity | "system stack" dev workspace | shippable product "Crew — a local AI work assistant" |
| Git | not a repo | full git repo |
| Installers | none | `bootstrap.sh` + `install.sh` + `package.sh` |
| Ports | 3456/3457/3458 | 3466/3467/3468 |

**Only in crew:** `my-brain/` (crew source: dispatcher+agents+skills compiled into an Obsidian vault), `recall/` (semantic search), `integrations/` (Gmail/Calendar/Slack/Salesforce/GWS), `.local/` (per-user vault/data/logs), `docs/`.
**Only in slackbot:** `scheduler/` (standalone jobs.json), `.agents/` + `.claude/agents/`.
**Subsystem differences:** slackbot has a *rich* slack-bot (Slack+Discord, commands, orchestration, MCP/permission servers); crew's slack-bot is stripped to 3 files. crew adds `crew.js`/`feed.js`/`notes.js` routes; slackbot has tests + `evals.js`.
**crew has a real `.env`** (0600) with live secrets (key names only inspected, values not printed).

---

## 3. "What if I wanted these features in the slackbot system? Is it all possible?"

Requested features:
1. Connect to Legacy Outlook (like crew)
2. Interact with Claude Code from Slack (like crew)
3. Create/manage custom agents, workflows, skills — incl. view/manage/add/remove **from within Slack**
4. Manage tasks via Slack tasks/reminders
5. Use canvases
6. Interact with Google Drive for Slack

**Verdict: all achievable.** Several are ports from crew.

| # | Feature | Verdict |
|---|---------|---------|
| 1 | Legacy Outlook | ✅ Easy — port crew's AppleScript skill verbatim |
| 2 | Claude from Slack | ✅ Already exists (bot's core) |
| 3/3a | Custom agents/workflows/skills | ✅ Exists; Slack management partial |
| 4 | Slack Lists / reminders | 🟡 Needs API verification |
| 5 | Canvases | ✅ Slack Canvas API |
| 6 | Google Drive | ✅ Reframe — integrate Drive directly (gws), not the Slack app |

Architecture insight: features land in one of three layers — **A. Slack transport**, **B. Agent MCP tools**, **C. Claude Code skills**.

---

## 4. "Search the web — would Slack Lists/reminders and Canvas work?"

Verified against live Slack docs:

- **Canvases — ✅ yes.** `canvases.create` / `conversations.canvases.create`, bot token, `canvases:write`/`canvases:read`. Free plan OK if channel-tabbed.
- **Lists — ✅ yes, with one condition.** `slackLists.create` / `slackLists.items.create|update|list`, bot token, `lists:write`/`lists:read`. **Requires a paid Slack plan.** Text fields must be `rich_text`.
- **Reminders — ⚠️ degraded.** `reminders.add` works (bot token, `reminders:write`) but is on a retirement path; Slack steers to Workflow automations. Use Lists/scheduler instead.

**Sources:** docs.slack.dev — Lists surface, slackLists.items.create, canvases.create, canvases.write scope, reminders changelog.

---

## 5. "Plan for those + the other features"

Produced **SLACK-FEATURES-PLAN.md** with architecture framing, prerequisites (paid plan for Lists, `@slack/web-api ≥ 7.8` for slackLists typings, new scopes), per-feature specs, and a 4-phase sequencing.

### Reminders discussion
Confirmed `reminders.add` still functions (bot token) but is degraded with no replacement API. **Decided:**
- `chat.scheduleMessage` = **primary** durable path for future messages (core API, ≤120 days, `chat:write`).
- `reminders.add` = native-reminder UX only.
- cron scheduler (`jobs.json`) = recurring.
- **Slack Workflow Builder workflows: NOT usable** (code-defined/deployed, "Steps from Apps" deprecated, separate Deno platform). Workflows live in the system's own runtime instead.

---

## 6. Implementation

### Phase 1 — Legacy Outlook (#1) ✅ DONE & VERIFIED LIVE
- Copied crew's `outlook/` skill (`mail.sh`, `cal.sh`) → `~/.claude/skills/outlook/`.
- Adapted `SKILL.md` script paths from relative → absolute `~/.claude/skills/outlook/…` (slackbot agents don't run from a vault root).
- **Verified live:** `mode` → `legacy`; account `<work-email>`; calendars enumerated (incl. a 2nd account `<second-account>`). macOS Automation already granted.

### Phase 2 — Canvases (#5) + time-based delivery (#4b) ✅ BUILT
Full vertical slice: MCP server → IPC server → tool impl → bot transport-proxy → SlackTransport.
- **New agent MCP tools:** `WriteCanvas`, `ScheduleMessage`, `ListScheduledMessages`, `CancelScheduledMessage`, `AddReminder`.
- Files: `orchestration/types.ts`, `channels/slack/transport.ts` (6 methods), `runtime-api/server.ts` (5 proxy endpoints), new `mcp/tools/{transport-proxy,write-canvas,schedule-message,add-reminder}.ts`, `ipc-server.ts`, `mcp/server.ts`, `toolsets.json` + `executor.ts` fallback.
- Canvas uses `apiCall` (version-proof); schedule/reminder use typed client methods.

### Phase 3 — Manage agents/workflows/skills from Slack (#3a) ✅ BUILT
- `$agents` already had CRUD; `$skills` already had list/add/remove. Gap was **workflows**.
- **New `$workflows` command** (`commands/workflows.ts`): list / run `<name> [sync|async]` (POSTs to runtime `/api/workflows/:name/run` with channel+thread) / create (conversational authoring) / delete (path-guarded). Wired into `message-processor.ts`, `$help`, CLAUDE.md.

### Phase 4 — Slack Lists (#4) + App Home tab (#2) ✅ BUILT
- **Lists** (correct-by-docs, `apiCall`): transport `createTaskList`/`addTask`/`listTasks`; `/api/transport-proxy/task` endpoint; MCP tools `CreateTaskList`/`AddTask`/`ListTasks`; `$tasks create|add|list` command (stateless, explicit list IDs).
- **App Home tab:** `channels/slack/home-view.ts` (`buildHomeBlocks()` — agents from FS, schedules from runtime API, quick commands) + `app_home_opened` handler in transport.
- ⚠️ Lists field shapes are correct-by-docs but **not live-tested** (needs paid plan).

---

## 7. Build verification

Initial `./deploy.sh` failed: `tsc: command not found` — `node_modules` was never installed in this checkout.

**Fix:** `npm install` in `slack-bot` + `agent-runtime`, then `npm run build` both → **clean, 0 type errors.** All Phase 2–4 TypeScript compile-verified. Confirmed `@slack/web-api` 7.x has the typed `chat.scheduleMessage`/`reminders.add` methods.

**Note:** `npm install` flagged pre-existing dependency vulnerabilities (slack-bot: 4 high; agent-runtime: 1 moderate / 2 high) — not from these changes; don't `npm audit fix` blindly.

---

## 8. Directory reconciliation

- This `Documents/claude-workspaces/slackbot` checkout is a **dev copy** — no LaunchAgent runs it. The only active services are `com.crew.*` pointing at `~/crew/` (the **crew** system is what's deployed).
- Renamed `slackbot` → `slack-bot` (clean: no external refs, no `.env` symlinks, not git). Verified build still passes from the new location.
- This produced a nested `slack-bot/slack-bot/` layout; user opted to rename the **root** to `slackbot-ai` to avoid the doubling.

---

## Outstanding / go-live checklist (all on the deploy side)

1. **Slack app settings** (api.slack.com): add scopes `canvases:write/read`, `reminders:write`, `lists:write/read`; enable **Home Tab** + subscribe to `app_home_opened`; **reinstall** the app.
2. **Paid Slack plan** for Lists (#4) to function.
3. **Live-test Lists** field shapes (item extraction, `columns.list` response) on a paid workspace.
4. Deploy: `./deploy.sh` (slack-bot) + `npm run build` & `launchctl kickstart` (agent-runtime) — note this checkout isn't currently wired to any LaunchAgent.
5. Google Drive (#6) — deferred.

**Status:** Phases 1–4 implemented; both subsystems compile clean. See `SLACK-FEATURES-PLAN.md` for the authoritative per-feature record.
