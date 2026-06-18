# Setup — Fresh Install on a New Mac

How to stand up the whole system (agent-runtime + slack-bot + management-api) from scratch on a
brand-new computer. There is **no installer yet** — this is the manual sequence. Steps marked
**[auto]** are scriptable (a future `bootstrap.sh` could do them); steps marked **[manual]** require
a human (browser sign-ins, Slack app creation, macOS permission grants).

> Notation: `<repo>` = wherever you put this checkout (e.g. `~/Documents/claude-workspaces/slackbot-ai`).
> Paths derive from `$HOME` + the repo location, so the checkout is relocatable.

---

## What you end up with

Three always-on localhost services, run as macOS LaunchAgents:

| Service | LaunchAgent | Port | Role |
|---|---|---|---|
| Agent runtime | `com.slackbot.runtime` | 3457 | Runs agents/jobs/workflows; per-job MCP tools |
| Slack bot | `com.slackbot.bot` | 3458 | Slack/Discord transport → interactive Claude Code sessions |
| Management API/UI | `com.slackbot.management` | 3456 | Web dashboard (localhost only) |

State lives outside the repo:
- `~/claude-workspaces/admin/` — the vault (global agents, cards, workflows, personas)
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
lists:read               lists:write             # $tasks / lists (needs a PAID plan)
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
mkdir -p ~/claude-workspaces/admin/{Agent,Card,_agent_actions,_workflows,_personas}
mkdir -p ~/claude-workspaces/general
mkdir -p <repo>/.local/logs <repo>/agent-runtime/data
```

`admin` is the vault (global agents/cards/workflows/personas). `general` is the default project
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

### 6b. Read your Slack messages "as you" [manual]
For features like "find my commitments from the last hour," the bot uses the **hosted Slack MCP**
(`https://mcp.slack.com/mcp`), which acts as the authenticated user. The bot session already requests
it (`SLACK_MCP_ENABLED` defaults on); you just authenticate once:

```bash
claude mcp add --transport http --scope user slack https://mcp.slack.com/mcp
claude                       # interactive
#   then:  /mcp  →  slack  →  Authenticate   (browser sign-in as yourself)
claude mcp list              # expect:  slack ... ✔ Connected
```

The OAuth token lands in the login Keychain; the bot's headless `claude --print` sessions (same macOS
user) reuse it automatically. Reads are scoped to what *your* account can see.

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

### 6d. Supermemory — long-term memory + recall [manual, optional]
Opt-in, self-hosted memory ([supermemory](https://github.com/supermemoryai/supermemory)). Fully offline:
an Ollama chat model extracts facts, embeddings run locally. When enabled, the bot/agents auto-recall
relevant memories into their prompts and gain `Recall`/`Memory` tools. The whole feature no-ops unless
`SUPERMEMORY_ENABLED=true`, so skipping this changes nothing.

1. **Install the server** (single local binary, no Docker): `curl -fsSL https://supermemory.ai/install | bash`
   → installs `~/.supermemory/bin/supermemory-server`.
2. **Pull an extraction model** (any Ollama chat model; embeddings are local regardless):
   `ollama pull llama3.1:8b`.
3. **Configure for Ollama** — write `~/.supermemory/env`:
   ```
   OPENAI_BASE_URL=http://localhost:11434/v1
   OPENAI_API_KEY=ollama
   OPENAI_MODEL=llama3.1:8b
   PORT=6767
   SUPERMEMORY_DATA_DIR=/Users/<you>/.supermemory/data
   ```
4. **First boot prints the API key** (`sm_…`): run `~/.supermemory/bin/supermemory-server` once, copy the key.
5. **Enable in the shared `.env`:**
   ```
   SUPERMEMORY_ENABLED=true
   SUPERMEMORY_URL=http://localhost:6767
   SUPERMEMORY_API_KEY=sm_...
   ```
6. **Run always-on** — create `~/Library/LaunchAgents/com.slackbot.supermemory.plist` (ProgramArguments =
   the binary; EnvironmentVariables = the §3 vars), `launchctl bootstrap gui/$(id -u) …`, then restart the
   bot + runtime so they pick up the env. Verify in the dashboard **Onboarding** tab (Supermemory → Verify now).

Recall searches stored content via `POST /v3/search`; new facts are added via `POST /v3/documents`.

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
- In Slack: DM the bot or `@`-mention it; `$help` lists commands. Open the bot's **Home** tab.

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
| 6b. Slack MCP OAuth | manual | `claude /mcp → Authenticate` browser sign-in |
| 7. Verify | **auto** | health checks |

## Not built yet (TODO for true reproducibility)
1. **Regenerate `slack-bot/slack-app-manifest.yaml`** to the current feature set (Home tab on,
   interactivity on, all scopes + events from §1) so app creation is paste-and-go.
2. **`bootstrap.sh`** automating every **[auto]** step (deps, build, `.env` scaffold, dirs, plists, health).
3. Keep this `SETUP.md` for the **[manual]** steps a script can't do.

After those, a new machine becomes: create the Slack app from the manifest → `./bootstrap.sh` → two
browser sign-ins (Slack MCP + Outlook permission).
