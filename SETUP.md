# Setup — Fresh Install on a New Mac

## Quick start (copy-paste)

On a brand-new Mac, this is the whole thing — five copy-paste blocks, no files to hand-edit:

```bash
# 1. Prereqs (skip any you already have)
brew install node
claude -p "say hi"          # confirm the Claude CLI is signed in (must return text)

# 2. Clone + bootstrap — installs deps, builds, makes dirs, scaffolds .env, starts all 3 services
git clone <your-repo-url> ~/claude-workspaces/system
cd ~/claude-workspaces/system
./scripts/bootstrap.sh

# 3. Create the Slack app: copy the manifest, then api.slack.com/apps → Create New App → From a manifest → paste
cat slack-bot/slack-app-manifest.yaml | pbcopy
#    In the app: generate an App-Level Token (scope connections:write) → xapp-… ;
#    Install to Workspace → Bot User OAuth Token → xoxb-… ; your member ID (profile → ⋯ → Copy member ID) → U…

# 4. Save the 3 Slack tokens (restarts the bot)
./scripts/set-slack-creds.sh xoxb-YOUR-BOT-TOKEN xapp-YOUR-APP-TOKEN U-YOUR-MEMBER-ID

# 5. (optional) Turn on local long-term memory
./scripts/install-mempalace.sh
```

Then open the dashboard → **Onboarding** tab: <http://localhost:3456/agents/#onboarding>. It live-checks
each integration and has the same copy-paste steps, plus optional add-ons (Slack read-as-you, Salesforce,
Drive, Outlook). The rest of this doc is the manual reference behind those scripts.

> Notation: `<repo>` = wherever you put this checkout (the documented location is `~/claude-workspaces/system`).
> Paths derive from `$HOME` + the repo location, so the checkout is relocatable. Steps marked **[auto]**
> are what `./scripts/bootstrap.sh` does for you; **[manual]** steps need a human (browser sign-ins,
> Slack app creation, macOS permission grants).

---

## What you end up with

Three always-on localhost services, run as macOS LaunchAgents:

| Service | LaunchAgent | Port | Role |
|---|---|---|---|
| Agent runtime | `com.slackbot.runtime` | 3457 | Runs agents/jobs/workflows; per-job MCP tools |
| Slack bot | `com.slackbot.bot` | 3458 | Slack/Discord transport → interactive Claude Code sessions |
| Management API/UI | `com.slackbot.management` | 3456 | Web dashboard (localhost only) |

State lives outside the repo:
- `~/claude-workspaces/global/` — the vault (global agents, cards, workflows, personas)
- `~/claude-workspaces/general/` — default project workspace (used when a channel isn't mapped)
- `~/claude-workspaces/channel-projects.json` — channel→project mappings
- `~/.claude/skills/outlook/` — Outlook skill (optional, for the Home tab)

---

## 0. Prerequisites [manual]

- **macOS.** Required — the system depends on launchd, Outlook AppleScript, and the login Keychain.
- **Node ≥ 20** (developed on v24). `brew install node`, or nvm. Note the absolute path to the
  `node`/`npm` bin dir — the LaunchAgents need it on PATH (e.g. `~/.nvm/versions/node/vX/bin` or
  `/opt/homebrew/bin`).
- **Claude Code CLI installed and signed in.** The bot *spawns* `claude`, so its auth must work on
  its own. Verify: `claude -p "say hi"` returns text. (Auth = a Claude Pro/Max/Team login, or
  `ANTHROPIC_API_KEY` in the environment.)
- **The code.** Copy this `slackbot-ai` folder onto the machine.

---

## 1. Create the Slack app [manual]

Create at <https://api.slack.com/apps> → **From a manifest**. Use the config below.

> ⚠️ The bundled `slack-bot/slack-app-manifest.yaml` is **out of date** (Home tab off, interactivity
> off, missing the canvas/list/reminder scopes and the `channel_created` / `app_home_opened` events).
> Until it's regenerated, use the values here, not the bundled file.

**Bot token scopes:**
```
app_mentions:read        chat:write              chat:write.public
channels:history         groups:history          im:history   im:read   im:write
users:read               reactions:write
canvases:read            canvases:write          # WriteCanvas
reminders:read           reminders:write         # AddReminder
lists:read               lists:write             # tasks / lists (needs a PAID plan)
files:read               files:write             # uploads + canvas/list permalinks
links:read               pins:read   pins:write
```

**Event subscriptions (bot events):**
```
app_mention            # @mentions
message.im             # DMs
member_joined_channel  # welcome message on add
channel_created        # auto-create a matching workspace folder
app_home_opened        # render the Home tab
```

**Settings:**
- **Socket Mode: ON** → generate an **App-Level Token** (`xapp-…`) with scope `connections:write`.
- **Interactivity: ON** (required for Home-tab buttons/modals, the unmap/refresh actions, and
  approval buttons).
- **App Home → Home Tab: ON**.

Then:
- **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-…`).
- Copy your **member ID** (your Slack profile → ⋯ → **Copy member ID**) → this is `SLACK_OWNER_USER_ID`
  (the bot is owner-locked to it).

**Plan note:** Slack **Lists** require a **paid** Slack plan. Everything else works on free.

---

## 2. Configure `.env` [auto]

Create `<repo>/.env` (one shared file, symlinked into each service):

```bash
cat > <repo>/.env <<EOF
# ── Slack app ──
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_OWNER_USER_ID=U...

# ── Internal auth (shared bot <-> runtime <-> management) ──
BOT_RUNTIME_SHARED_SECRET=$(openssl rand -hex 24)

# ── Ports (localhost) ──
MANAGEMENT_PORT=3456
RUNTIME_HTTP_PORT=3457
BOT_HTTP_PORT=3458
MANAGEMENT_BIND_HOST=127.0.0.1

# ── Public base URL for "manage at…" links + HTML previews (e.g. a Tailscale URL) ──
PUBLIC_BASE_URL=http://localhost:3456
EOF
chmod 600 <repo>/.env

# symlink into each subsystem
for s in slack-bot agent-runtime management-api; do ln -sf ../.env "<repo>/$s/.env"; done
```

Path-type settings (`VAULT_PATH`, `BASE_DIRECTORY`, `CLAUDE_PATH`, `DATA_DIR`, `JOBS_FILE`, log paths)
are intentionally **omitted** — the code derives them from `$HOME` / the repo location. Override only
if you need to.

---

## 3. Install dependencies + build [auto]

```bash
cd <repo>
( cd shared && npm install --no-audit --no-fund )
( cd management-api && npm install --no-audit --no-fund )
( cd slack-bot && npm install && npm run build )
( cd agent-runtime && npm install && npm run build )
```

`management-api` and `shared` are plain JS (no build). `slack-bot` and `agent-runtime` are TypeScript;
they run via `tsx` at runtime but should build clean (0 errors) before going live.

---

## 4. Create workspace + vault dirs [auto]

```bash
mkdir -p ~/claude-workspaces/global/{Agent,Card,_agent_actions,_workflows,_personas}
mkdir -p ~/claude-workspaces/general
mkdir -p <repo>/.local/logs <repo>/agent-runtime/data
```

`global` is the vault (global agents/cards/workflows/personas). `general` is the default project
workspace used for DMs and unmapped channels.

---

## 5. Install the LaunchAgents [auto]

Create three plists in `~/Library/LaunchAgents/`. Template (substitute `<repo>` and the node bin path;
launchd does **not** expand `$HOME` or `~` inside plist paths, so they must be absolute):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.slackbot.runtime</string>
  <key>WorkingDirectory</key><string><repo>/agent-runtime</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string><string>exec npm start</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/Users/<you>/.nvm/versions/node/vX/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string><repo>/.local/logs/com.slackbot.runtime.out.log</string>
  <key>StandardErrorPath</key><string><repo>/.local/logs/com.slackbot.runtime.err.log</string>
</dict>
</plist>
```

Repeat for `com.slackbot.bot` (WorkingDirectory `<repo>/slack-bot`) and `com.slackbot.management`
(WorkingDirectory `<repo>/management-api`). Then load them (runtime first):

```bash
UID=$(id -u)
for s in runtime management bot; do
  launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.slackbot.$s.plist
done
```

Manage later:
```bash
launchctl list | grep com.slackbot                          # status
launchctl kickstart -k gui/$(id -u)/com.slackbot.bot        # restart one
launchctl bootout   gui/$(id -u)/com.slackbot.bot           # stop one
# after editing bot code:  cd slack-bot && ./deploy.sh       # build, then restart on success
```

---

## 6. Optional integrations

### 6a. Outlook → Home tab inbox + calendar [manual]
The Home tab shows your last 10 Outlook emails and upcoming events via the `outlook` skill.

1. Copy the skill to `~/.claude/skills/outlook/` (`mail.sh`, `cal.sh`, `SKILL.md`).
2. Outlook for Mac must be in **Legacy** mode (New Outlook has no working AppleScript).
3. First run will trigger a macOS **Automation** permission prompt — allow it.
   Verify: `bash ~/.claude/skills/outlook/mail.sh mode` prints `legacy`.

Without this, the Home tab still renders — it just shows a "not reachable" note instead of mail/events.

### 6b. Read your Slack messages "as you" — user token [manual]
For features like "find my commitments from the last hour" or reading a channel the bot isn't in,
the bot reads as you via a **user token** (`xoxp-`) — powering the `SearchMessages` /
`ReadChannelMessages` tools. Read-only; it never posts as you. Works headlessly (unlike the
OAuth-based hosted Slack MCP, which is off by default — set `SLACK_MCP_ENABLED=true` to opt back in).

```bash
# In api.slack.com/apps → your app → OAuth & Permissions → User Token Scopes, add:
#   search:read channels:history channels:read groups:history groups:read im:history mpim:history users:read
# Reinstall to Workspace, copy the User OAuth Token (xoxp-…), then:
./scripts/set-slack-creds.sh xoxb-YOUR-BOT-TOKEN xapp-YOUR-APP-TOKEN U-YOUR-MEMBER-ID xoxp-YOUR-USER-TOKEN
```

The token is written to `.env` (gitignored) and the bot uses it on restart. Reads are scoped to what
*your* account can see.

### 6c. Salesforce orgs via the `sf` CLI [manual]
Lets the bot query/describe/inspect Salesforce orgs ("query my acme-sandbox org for…", "describe the
Account object", "list flows in <org>"). No MCP — it's the `sf` CLI driven via Bash, guided by a skill.

1. **Install the CLI:** `npm install -g @salesforce/cli` (or `brew install salesforcedx`). Verify: `sf --version`.
2. **Authenticate each org** (browser, once per org): `sf org login web --alias <alias>`. Tokens are
   stored by the `sf` CLI (machine-global), so the bot reuses them — no per-session login.
   List them anytime with `sf org list`.
3. **Install the skill:** copy `salesforce/SKILL.md` to `~/.claude/skills/salesforce/SKILL.md`. It
   teaches Claude to always target an explicit `--target-org <alias>`, run reads freely, and **gate
   writes** (create/update/delete, Apex, deploys) behind explicit confirmation — and never write in
   unattended/scheduled runs.

The bot already has the `Bash` tool, so once the CLI is authenticated and the skill is present, no
code changes are needed. **Safety:** the skill requires naming the org on every command and confirming
before any write — important since one machine is authenticated to many client orgs (sandbox/prod).

### 6d. Long-term memory — MemPalace [manual, optional]
Opt-in local memory ([MemPalace](https://github.com/mempalace/mempalace)). **Fully offline** — local
embeddings, **no API key, no LLM, no server**. When enabled, the bot/agents auto-recall relevant context
into their prompts and gain MemPalace's search tools. The whole feature no-ops unless `MEMORY_ENABLED=true`,
so skipping this changes nothing.

1. **Install the CLI** (Python, no Docker): `uv tool install mempalace` (or `pipx install mempalace`).
   Installs `mempalace` + `mempalace-mcp` to `~/.local/bin`.
2. **Index your content** (first run downloads a ~300 MB embedding model):
   ```
   mempalace mine ~/claude-workspaces
   ```
   (Only the curated workspaces — not `~/.claude/projects`, which would pull in stale/cross-client session history.)
   This is automated going forward by the `mempalace-mine` scheduler job (hourly, idempotent) —
   `scripts/mempalace-mine.sh`, which self-gates on `MEMORY_ENABLED`.
3. **Enable it:** set `MEMORY_ENABLED=true` in the shared `.env` (or flip the toggle in the dashboard
   **Onboarding** tab, which also restarts the bot + runtime). That's the only env var memory needs.
4. **Verify:** `mempalace search "something you indexed"` should return matches offline.

How it's wired: the bot/runtime shell out to `mempalace search` for auto-recall, and the bot registers
MemPalace's native `mempalace-mcp` stdio server for in-session search tools. No REST API, no daemon.

---

## 7. Verify [auto]

```bash
launchctl list | grep com.slackbot                          # three rows, exit code 0
SECRET=$(grep '^BOT_RUNTIME_SHARED_SECRET=' <repo>/.env | cut -d= -f2-)
curl -s -o /dev/null -w "mgmt %{http_code}\n"  http://127.0.0.1:3456/agents/
curl -s -o /dev/null -w "rtm  %{http_code}\n"  -H "X-Bot-Auth: $SECRET" http://127.0.0.1:3457/api/jobs
curl -s -o /dev/null -w "bot  %{http_code}\n"  http://127.0.0.1:3458/   # 401 = up (auth enforced)
grep "is running" <repo>/.local/logs/com.slackbot.bot.out.log | tail -1   # ⚡️ bot is running
```
- Web dashboard: <http://localhost:3456/agents/>
- In Slack: DM the bot or `@`-mention it; `help` lists commands. Open the bot's **Home** tab.

---

## Quick reference — what's manual vs scriptable

| Step | Type | Notes |
|---|---|---|
| 0. Prereqs (Node, Claude CLI auth, code) | manual | one-time machine setup |
| 1. Slack app create + tokens + member ID | manual | browser; needs the corrected manifest |
| 2. `.env` + symlinks | **auto** | prompts for 3 Slack values, generates the secret |
| 3. npm install + build | **auto** | |
| 4. workspace/vault dirs | **auto** | |
| 5. LaunchAgents | **auto** | generate plists, bootstrap |
| 6a. Outlook | manual | Legacy mode + Automation grant |
| 6b. Slack user token | manual | add user scopes + reinstall → `set-slack-creds.sh … <xoxp>` |
| 7. Verify | **auto** | health checks |

## Helper scripts (the copy-paste path)

| Script | What it does |
|---|---|
| `scripts/bootstrap.sh` | Every **[auto]** step: deps, build, dirs, `.env` scaffold + symlinks, generate + load the 3 LaunchAgents, health check. Idempotent. |
| `scripts/set-slack-creds.sh <xoxb> <xapp> <U-id>` | Writes the 3 Slack tokens into `.env` and restarts the bot. |
| `scripts/install-mempalace.sh` | Installs MemPalace, indexes content, enables memory, restarts consumers. |
| `scripts/mempalace-mine.sh` | Re-mines workspaces + Claude transcripts (the hourly `mempalace-mine` job; self-gates on `MEMORY_ENABLED`). |

`slack-bot/slack-app-manifest.yaml` is current (Home tab + interactivity on, all scopes/events) — paste it
into **Create New App → From a manifest**.

What's still manual (a script can't): creating the Slack app + generating its tokens (browser), the Slack
MCP OAuth (`claude → /mcp → Authenticate`), `sf org login web` per org, installing Google Drive for
Desktop, and switching Outlook to Legacy mode + the macOS Automation grant.
