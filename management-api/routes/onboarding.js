const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { baseDirectory } = require('../../shared/config');

const router = express.Router();
const HOME = os.homedir();
const CLAUDE = process.env.CLAUDE_PATH || path.join(HOME, '.local', 'bin', 'claude');
const SECRET = process.env.BOT_RUNTIME_SHARED_SECRET || '';
const RUNTIME = `http://127.0.0.1:${process.env.RUNTIME_HTTP_PORT || 3457}`;
const BOT = `http://127.0.0.1:${process.env.BOT_HTTP_PORT || 3458}`;

// Run a command without a shell; never rejects.
function sh(cmd, args, timeout = 12000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, env: process.env }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}
async function httpCode(url, headers) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
    return r.status;
  } catch { return 0; }
}
// status: 'ok' | 'warn' | 'missing' | 'error'
const item = (id, label, status, detail, fix) => ({ id, label, status, detail: detail || '', fix: fix || '' });

// Shared .env lives at the repo root (management-api is a direct child). Read/write a single flag
// in place so a UI toggle can flip it; consumers (bot/runtime) pick it up on restart.
const ENV_PATH = path.join(__dirname, '..', '..', '.env');
function readEnvFlag(name) {
  try {
    const m = fs.readFileSync(ENV_PATH, 'utf8').match(new RegExp('^' + name + '=(.*)$', 'm'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}
function setEnvFlag(name, value) {
  let txt = '';
  try { txt = fs.readFileSync(ENV_PATH, 'utf8'); } catch { /* new file */ }
  const line = `${name}=${value}`;
  const re = new RegExp('^' + name + '=.*$', 'm');
  txt = re.test(txt) ? txt.replace(re, line) : (txt + (txt && !txt.endsWith('\n') ? '\n' : '') + line + '\n');
  fs.writeFileSync(ENV_PATH, txt);
}

async function checkServices() {
  const [rt, bot] = await Promise.all([httpCode(`${RUNTIME}/api/jobs`, { 'X-Bot-Auth': SECRET }), httpCode(`${BOT}/`, {})]);
  const rtOk = rt === 200;
  const botOk = bot === 401 || bot === 200; // bot enforces auth -> 401 means it's up
  if (rtOk && botOk) return item('services', 'Core services (runtime + bot)', 'ok', `runtime ${rt}, bot ${bot}`);
  return item('services', 'Core services (runtime + bot)', 'missing', `runtime ${rt || 'down'}, bot ${bot || 'down'}`,
    'Start them: launchctl kickstart -k gui/$(id -u)/com.slackbot.runtime  (and .bot)');
}

async function checkSlackScopes() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return item('slack_app', 'Slack app + scopes', 'missing', 'SLACK_BOT_TOKEN not set', 'Add SLACK_BOT_TOKEN to .env');
  try {
    const r = await fetch('https://slack.com/api/auth.test', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) });
    const scopes = (r.headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim());
    const j = await r.json();
    if (!j.ok) return item('slack_app', 'Slack app + scopes', 'missing', j.error, 'Check the tokens / reinstall the Slack app');
    const want = ['chat:write', 'canvases:write', 'lists:read', 'lists:write', 'reminders:write', 'channels:read'];
    const missing = want.filter((s) => !scopes.includes(s));
    if (!missing.length) return item('slack_app', `Slack app (@${j.user})`, 'ok', 'all key scopes present');
    return item('slack_app', `Slack app (@${j.user})`, 'warn', `missing scopes: ${missing.join(', ')}`,
      'Add the missing scopes in api.slack.com → OAuth & Permissions, then Reinstall to Workspace');
  } catch (e) { return item('slack_app', 'Slack app + scopes', 'error', String(e.message)); }
}

async function checkSlackMcp() {
  const r = await sh(CLAUDE, ['mcp', 'list'], 15000);
  const line = r.stdout.split('\n').find((l) => /slack[:\s].*mcp\.slack\.com/i.test(l)) || '';
  if (/✔|connected/i.test(line)) return item('slack_mcp', 'Slack MCP (read messages as you)', 'ok', 'connected');
  if (line) return item('slack_mcp', 'Slack MCP (read messages as you)', 'warn', 'registered but not authenticated',
    'In a terminal: claude → /mcp → slack → Authenticate (browser sign-in)');
  return item('slack_mcp', 'Slack MCP (read messages as you)', 'missing', 'not registered',
    'Run: claude mcp add --transport http --scope user slack https://mcp.slack.com/mcp  — then claude → /mcp → slack → Authenticate');
}

async function checkSalesforce() {
  const v = await sh('sf', ['--version'], 8000);
  if (!v.ok) return item('salesforce', 'Salesforce CLI + orgs', 'missing', 'sf not installed', 'npm install -g @salesforce/cli');
  const r = await sh('sf', ['org', 'list', '--json'], 12000);
  try {
    const j = JSON.parse(r.stdout);
    const all = [...(j.result?.nonScratchOrgs || []), ...(j.result?.scratchOrgs || []), ...(j.result?.devHubs || [])];
    const aliases = [...new Set(all.map((o) => o.alias || o.username))];
    if (aliases.length) return item('salesforce', `Salesforce CLI (${aliases.length} org${aliases.length !== 1 ? 's' : ''})`, 'ok', aliases.slice(0, 8).join(', '));
    return item('salesforce', 'Salesforce CLI + orgs', 'warn', 'CLI installed, no orgs authenticated', 'Authenticate one: sf org login web --alias <name>');
  } catch { return item('salesforce', 'Salesforce CLI + orgs', 'warn', 'could not list orgs', 'sf org login web --alias <name>'); }
}

function checkDrive() {
  try {
    const cs = path.join(HOME, 'Library', 'CloudStorage');
    const mounts = fs.existsSync(cs) ? fs.readdirSync(cs).filter((d) => d.startsWith('GoogleDrive-')) : [];
    if (mounts.length) return item('drive', 'Google Drive for Desktop', 'ok', mounts[0]);
    return item('drive', 'Google Drive for Desktop', 'missing', 'no GoogleDrive mount found', 'Install Google Drive for Desktop and sign in');
  } catch (e) { return item('drive', 'Google Drive for Desktop', 'error', String(e.message)); }
}

async function checkOutlook() {
  const script = path.join(HOME, '.claude', 'skills', 'outlook', 'mail.sh');
  if (!fs.existsSync(script)) return item('outlook', 'Outlook (Home tab inbox/calendar)', 'missing', 'outlook skill not installed', 'Install the outlook skill to ~/.claude/skills/outlook/');
  const r = await sh('bash', [script, 'mode'], 8000);
  const mode = r.stdout.trim();
  if (mode === 'legacy') return item('outlook', 'Outlook (Legacy mode)', 'ok', 'legacy mode — scriptable');
  if (mode === 'new') return item('outlook', 'Outlook (Home tab inbox/calendar)', 'warn', 'New Outlook is not scriptable', 'Switch Outlook for Mac to Legacy mode');
  return item('outlook', 'Outlook (Home tab inbox/calendar)', 'warn', mode || 'not reachable', 'Open Outlook (Legacy mode), sign in, and grant the macOS Automation permission');
}

// Supermemory is an OPTIONAL feature: 'ok' when off (nothing wrong) or running,
// 'warn' only when enabled-but-unreachable (needs the server started).
async function checkSupermemory() {
  // Read from the .env file (not process.env) so a UI toggle is reflected without restarting this API.
  const enabled = readEnvFlag('SUPERMEMORY_ENABLED') === 'true';
  const url = process.env.SUPERMEMORY_URL || 'http://localhost:6767';
  const code = await httpCode(`${url}/`);
  const reachable = code === 200;
  if (!enabled) {
    return { ...item('supermemory', 'Supermemory (long-term memory)', 'ok',
      reachable ? 'disabled — optional (server is running, just not in use)' : 'disabled — optional feature',
      'Optional. Toggle it on here once the server is installed and running.'), enabled: false, reachable };
  }
  if (reachable) return { ...item('supermemory', 'Supermemory (long-term memory)', 'ok', `enabled — running at ${url}`), enabled: true, reachable };
  return { ...item('supermemory', 'Supermemory (long-term memory)', 'warn', `enabled but not reachable at ${url}`,
    'Start it: launchctl kickstart -k gui/$(id -u)/com.slackbot.supermemory'), enabled: true, reachable };
}

// ─────────────────────────────────────────────────────────────────────────
// Guided setup wizard content.
// Each guide's `id` aligns with a /status item id where a live check exists
// (services, slack_app, slack_mcp, salesforce, drive, outlook); `manual: true`
// guides (prereqs, env) have no auto-check and are confirmed by the user.
// Steps render in order; `code` blocks get a copy button in the dashboard.
// ─────────────────────────────────────────────────────────────────────────
const GUIDE = [
  {
    id: 'prereqs', label: 'Prerequisites', manual: true,
    why: 'The bot spawns the Claude CLI and runs as macOS LaunchAgents, so these must work on their own first.',
    steps: [
      { title: 'macOS + Node ≥ 20', body: 'Install Node (developed on v24). Note the absolute path to its bin dir — the LaunchAgents need it on PATH.', code: 'brew install node\nwhich node    # note this path' },
      { title: 'Claude Code CLI signed in', body: 'The bot spawns `claude`, so its auth must work independently. This should return text:', code: 'claude -p "say hi"' },
      { title: 'Get the code', body: 'Copy this `slackbot-ai` folder onto the machine. Everything else derives from `$HOME` + the repo location.' },
    ],
  },
  {
    id: 'env', label: 'Environment (.env)', manual: true,
    why: 'One shared .env is symlinked into each service. It holds the Slack tokens and the internal shared secret.',
    steps: [
      { title: 'Create the shared .env', body: 'In the repo root. Fill the three Slack values from the next step; the secret is generated for you.',
        code: 'cat > .env <<EOF\nSLACK_BOT_TOKEN=xoxb-...\nSLACK_APP_TOKEN=xapp-...\nSLACK_OWNER_USER_ID=U...\nBOT_RUNTIME_SHARED_SECRET=$(openssl rand -hex 24)\nMANAGEMENT_PORT=3456\nRUNTIME_HTTP_PORT=3457\nBOT_HTTP_PORT=3458\nMANAGEMENT_BIND_HOST=127.0.0.1\nPUBLIC_BASE_URL=http://localhost:3456\nEOF\nchmod 600 .env' },
      { title: 'Symlink it into each service', code: 'for s in slack-bot agent-runtime management-api; do ln -sf ../.env "$s/.env"; done' },
    ],
  },
  {
    id: 'services', label: 'Core services', check: 'services',
    why: 'agent-runtime (3457), slack-bot (3458) and management-api (3456) run as always-on LaunchAgents.',
    steps: [
      { title: 'Install deps + build', code: '( cd shared && npm install --no-audit --no-fund )\n( cd management-api && npm install --no-audit --no-fund )\n( cd slack-bot && npm install && npm run build )\n( cd agent-runtime && npm install && npm run build )' },
      { title: 'Create workspace + vault dirs', code: 'mkdir -p ~/claude-workspaces/admin/{Agent,Card,_agent_actions,_workflows,_personas}\nmkdir -p ~/claude-workspaces/general\nmkdir -p .local/logs agent-runtime/data' },
      { title: 'Install the three LaunchAgents', body: 'Create `~/Library/LaunchAgents/com.slackbot.{runtime,bot,management}.plist` (see SETUP.md §5 for the template — paths must be absolute, and PATH must include your node bin dir). Then load them, runtime first:',
        code: 'UID=$(id -u)\nfor s in runtime management bot; do\n  launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.slackbot.$s.plist\ndone' },
      { title: 'Restart later / check status', code: 'launchctl list | grep com.slackbot\nlaunchctl kickstart -k gui/$(id -u)/com.slackbot.bot' },
    ],
  },
  {
    id: 'slack_app', label: 'Slack app + scopes', check: 'slack_app',
    why: 'The bot talks to Slack via a Slack app in Socket Mode. You create it once and paste two tokens into .env.',
    steps: [
      { title: 'Create the app from a manifest', body: 'Go to api.slack.com/apps → Create New App → From a manifest. (The bundled manifest is out of date — use the scopes/events below.)' },
      { title: 'Bot token scopes', body: 'Under OAuth & Permissions, add these bot scopes:',
        code: 'app_mentions:read chat:write chat:write.public\nchannels:history groups:history im:history im:read im:write\nusers:read reactions:write\ncanvases:read canvases:write\nreminders:read reminders:write\nlists:read lists:write   # Lists need a PAID Slack plan\nfiles:read files:write links:read pins:read pins:write' },
      { title: 'Event subscriptions', body: 'Subscribe to these bot events:', code: 'app_mention\nmessage.im\nmember_joined_channel\nchannel_created\napp_home_opened' },
      { title: 'Turn on Socket Mode, Interactivity, Home tab', body: 'Socket Mode: ON → generate an App-Level Token (xapp-…) with `connections:write`. Interactivity: ON. App Home → Home Tab: ON.' },
      { title: 'Install + collect tokens', body: 'Install to Workspace → copy the Bot User OAuth Token (xoxb-…). Copy the app-level token (xapp-…). From your Slack profile → ⋯ → Copy member ID (U…). Put all three in .env (previous section), then reinstall the bot:', code: 'launchctl kickstart -k gui/$(id -u)/com.slackbot.bot' },
    ],
  },
  {
    id: 'slack_mcp', label: 'Read your Slack messages', check: 'slack_mcp',
    why: 'For "find my commitments from the last hour," the bot uses the hosted Slack MCP, acting as you. Authenticate once; the OAuth token lands in your login Keychain and headless sessions reuse it.',
    steps: [
      { title: 'Register the hosted MCP', code: 'claude mcp add --transport http --scope user slack https://mcp.slack.com/mcp' },
      { title: 'Authenticate as yourself', body: 'Open Claude interactively, then authenticate via the browser:', code: 'claude\n#   then:  /mcp  →  slack  →  Authenticate' },
      { title: 'Confirm connected', code: 'claude mcp list    # expect: slack ... ✔ Connected' },
    ],
  },
  {
    id: 'salesforce', label: 'Salesforce orgs', check: 'salesforce',
    why: 'Lets the bot query/describe orgs via the sf CLI (no MCP). Authenticate each org once; tokens are machine-global so the bot reuses them.',
    steps: [
      { title: 'Install the CLI', code: 'npm install -g @salesforce/cli\nsf --version' },
      { title: 'Authenticate each org (browser, once)', code: 'sf org login web --alias <alias>\nsf org list' },
      { title: 'Install the salesforce skill', body: 'Copy `salesforce/SKILL.md` to `~/.claude/skills/salesforce/SKILL.md`. It is read-only by instruction and always targets an explicit `--target-org`.' },
    ],
  },
  {
    id: 'drive', label: 'Google Drive', check: 'drive',
    why: 'Projects can bind a Google Drive folder. Using Google Drive for Desktop, Claude reads/writes it with normal file tools — no API/OAuth.',
    steps: [
      { title: 'Install Google Drive for Desktop', body: 'Install from google.com/drive/download and sign in. It mounts under `~/Library/CloudStorage/GoogleDrive-<account>/`.' },
      { title: 'Bind a folder to a project', body: 'Later, on a project: `$project drive <absolute path>` in Slack, or the Projects tab here.' },
    ],
  },
  {
    id: 'outlook', label: 'Outlook (Home tab)', check: 'outlook',
    why: 'Optional. Powers the Home tab inbox + calendar via the outlook skill. Requires Outlook for Mac in Legacy mode.',
    steps: [
      { title: 'Install the outlook skill', body: 'Copy the skill (mail.sh, cal.sh, SKILL.md) to `~/.claude/skills/outlook/`.' },
      { title: 'Switch Outlook to Legacy mode', body: 'New Outlook has no working AppleScript. In Outlook for Mac, turn off "New Outlook".' },
      { title: 'Grant Automation + verify', body: 'First run triggers a macOS Automation permission prompt — allow it. Then:', code: 'bash ~/.claude/skills/outlook/mail.sh mode   # prints: legacy' },
    ],
  },
  {
    id: 'supermemory', label: 'Supermemory (long-term memory)', check: 'supermemory', optional: true, toggle: true,
    why: 'Optional self-hosted memory + recall, fully offline (Ollama for fact extraction, local embeddings). When enabled, the bot and agents auto-recall relevant facts and can store new ones with the Memory/Recall tools.',
    steps: [
      { title: 'Install the server', body: 'Installs a single local binary to ~/.supermemory/bin (no Docker).', code: 'curl -fsSL https://supermemory.ai/install | bash' },
      { title: 'Pull the extraction model (offline)', body: 'Any Ollama chat model works; embeddings run locally regardless.', code: 'ollama pull llama3.1:8b' },
      { title: 'Configure for Ollama', body: 'Edit ~/.supermemory/env:', code: 'OPENAI_BASE_URL=http://localhost:11434/v1\nOPENAI_API_KEY=ollama\nOPENAI_MODEL=llama3.1:8b\nPORT=6767\nSUPERMEMORY_DATA_DIR=~/.supermemory/data' },
      { title: 'Enable it in this system', body: 'The API key prints on first server boot (sm_…). Add to the shared .env:', code: 'SUPERMEMORY_ENABLED=true\nSUPERMEMORY_URL=http://localhost:6767\nSUPERMEMORY_API_KEY=sm_...' },
      { title: 'Run always-on + restart consumers', body: 'Install the com.slackbot.supermemory LaunchAgent (see SETUP.md §6), then restart the bot + runtime so they pick up the env:', code: 'launchctl kickstart -k gui/$(id -u)/com.slackbot.bot\nlaunchctl kickstart -k gui/$(id -u)/com.slackbot.runtime' },
    ],
  },
];

// GET /guide — the step-by-step setup content for the wizard
router.get('/guide', (_req, res) => res.json({ guide: GUIDE }));

// GET /preferences/default — the starting org-wide working-preferences template
// (shipped in templates/; the onboarding flow pre-fills it so the user can edit + save)
const DEFAULT_PREFS_FILE = path.join(__dirname, '..', 'templates', 'default-preferences.md');
router.get('/preferences/default', (_req, res) => {
  try {
    const text = fs.existsSync(DEFAULT_PREFS_FILE) ? fs.readFileSync(DEFAULT_PREFS_FILE, 'utf8') : '';
    res.json({ text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /status — readiness of every integration (cached 20s)
let _cache = { at: 0, data: null };
router.get('/status', async (req, res) => {
  try {
    if (_cache.data && Date.now() - _cache.at < 20000 && !req.query.fresh) return res.json(_cache.data);
    const items = await Promise.all([
      checkServices(), checkSlackScopes(), checkSlackMcp(), checkSalesforce(), Promise.resolve(checkDrive()), checkOutlook(), checkSupermemory(),
    ]);
    const summary = { ok: items.filter((c) => c.status === 'ok').length, warn: items.filter((c) => c.status === 'warn').length, missing: items.filter((c) => c.status === 'missing' || c.status === 'error').length, total: items.length };
    _cache = { at: Date.now(), data: { items, summary } };
    res.json(_cache.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /status/:id — re-run a single integration check (used by the wizard's "Verify now")
const CHECKS = {
  services: checkServices, slack_app: checkSlackScopes, slack_mcp: checkSlackMcp,
  salesforce: checkSalesforce, drive: () => Promise.resolve(checkDrive()), outlook: checkOutlook,
  supermemory: checkSupermemory,
};
router.get('/status/:id', async (req, res) => {
  const fn = CHECKS[req.params.id];
  if (!fn) return res.status(404).json({ error: 'unknown check' });
  try { res.json(await fn()); } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /supermemory/toggle — enable/disable the optional memory feature for the assistant.
// Flips SUPERMEMORY_ENABLED in the shared .env and restarts the bot + runtime so they pick it up.
// (The Supermemory server itself has its own LaunchAgent; on enable we also try to (re)start it.)
router.post('/supermemory/toggle', (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  try {
    setEnvFlag('SUPERMEMORY_ENABLED', enabled ? 'true' : 'false');
    const uid = typeof process.getuid === 'function' ? process.getuid() : '';
    const targets = ['bot', 'runtime'].concat(enabled ? ['supermemory'] : []);
    for (const svc of targets) {
      sh('launchctl', ['kickstart', '-k', `gui/${uid}/com.slackbot.${svc}`]).catch(() => {});
    }
    res.json({ ok: true, enabled, note: 'Saved. Bot + runtime are restarting to apply (a few seconds).' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /preferences — append an organizational preference to a CLAUDE.md (global or project scope)
router.post('/preferences', (req, res) => {
  try {
    const { scope, text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text is required' });
    let file;
    if (!scope || scope === 'global') {
      file = path.join(HOME, '.claude', 'CLAUDE.md');
    } else {
      if (!/^[A-Za-z0-9_-]+$/.test(scope)) return res.status(400).json({ error: 'invalid project scope' });
      file = path.join(baseDirectory, scope, 'CLAUDE.md');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const header = fs.existsSync(file) ? '' : '# Preferences\n';
    fs.appendFileSync(file, `${header}\n<!-- via onboarding ${stamp} -->\n${String(text).trim()}\n`);
    res.json({ ok: true, file, scope: scope || 'global' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
