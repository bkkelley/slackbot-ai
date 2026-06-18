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

// Optional memory feature (MemPalace). 'ok' when off (nothing wrong) or installed+enabled;
// 'warn' only when enabled but the mempalace CLI isn't installed.
const MEMPALACE_BIN = process.env.MEMPALACE_BIN || path.join(HOME, '.local', 'bin', 'mempalace');
async function checkMemory() {
  // Read MEMORY_ENABLED from the .env file (not process.env) so a UI toggle reflects immediately.
  const enabled = readEnvFlag('MEMORY_ENABLED') === 'true';
  const installed = fs.existsSync(MEMPALACE_BIN);
  if (!enabled) {
    return { ...item('memory', 'Long-term memory (MemPalace)', 'ok',
      installed ? 'disabled — optional (MemPalace installed, not in use)' : 'disabled — optional feature',
      'Optional. Install MemPalace (see steps below), then toggle it on here.'), enabled: false, installed };
  }
  if (installed) return { ...item('memory', 'Long-term memory (MemPalace)', 'ok', 'enabled — MemPalace installed'), enabled: true, installed };
  return { ...item('memory', 'Long-term memory (MemPalace)', 'warn', 'enabled but the mempalace CLI was not found',
    'Install it: uv tool install mempalace  (or: pipx install mempalace)'), enabled: true, installed };
}

// ─────────────────────────────────────────────────────────────────────────
// Guided setup wizard content.
// Each guide's `id` aligns with a /status item id where a live check exists
// (services, slack_app, slack_mcp, salesforce, drive, outlook, memory); the `prereqs`
// guide is `manual: true` (no auto-check). Each step aims to be a single copy-paste
// command (often a scripts/*.sh) rather than instructions to interpret; `code` blocks
// get a copy button in the dashboard.
// ─────────────────────────────────────────────────────────────────────────
const GUIDE = [
  {
    id: 'prereqs', label: 'Prerequisites', manual: true,
    why: 'The bot spawns the Claude CLI and runs as macOS LaunchAgents, so these must work first.',
    steps: [
      { title: 'Install Node ≥ 20', code: 'brew install node' },
      { title: 'Confirm the Claude CLI is signed in', body: 'The bot spawns `claude`, so its auth must work on its own. This should return text:', code: 'claude -p "say hi"' },
      { title: 'Clone the repo', body: 'Everything else derives from this folder + $HOME.', code: 'git clone <your-repo-url> ~/Documents/claude-workspaces/slackbot-ai\ncd ~/Documents/claude-workspaces/slackbot-ai' },
    ],
  },
  {
    id: 'services', label: 'Install & run everything', check: 'services',
    why: 'One script installs dependencies, builds, creates the workspace/vault dirs, scaffolds .env, and installs + starts all three services (runtime 3457, bot 3458, dashboard 3456). Idempotent — safe to re-run.',
    steps: [
      { title: 'Run the bootstrap script (from the repo root)', body: 'When it finishes, the dashboard is live at http://localhost:3456/agents/ — the only thing left is your Slack app below.', code: './scripts/bootstrap.sh' },
    ],
  },
  {
    id: 'slack_app', label: 'Slack app + tokens', check: 'slack_app',
    why: 'The bot connects through a Slack app (Socket Mode). Create it from the bundled manifest — no scopes/events to type — then save its 3 tokens with one command.',
    steps: [
      { title: 'Copy the app manifest to your clipboard', body: 'Then go to api.slack.com/apps → Create New App → From a manifest, and paste.', code: 'cat slack-bot/slack-app-manifest.yaml | pbcopy' },
      { title: 'Generate the tokens (clicks, in the Slack app)', body: 'Basic Information → App-Level Tokens → Generate with scope connections:write (copy the xapp-…). Then Install to Workspace and copy the Bot User OAuth Token (xoxb-…). Finally, your member ID: Slack profile → ⋯ → Copy member ID (U…).' },
      { title: 'Save the 3 tokens (one command, from the repo root)', body: 'Writes them to .env and restarts the bot.', code: './scripts/set-slack-creds.sh xoxb-YOUR-BOT-TOKEN xapp-YOUR-APP-TOKEN U-YOUR-MEMBER-ID' },
    ],
  },
  {
    id: 'slack_mcp', label: 'Read your Slack messages', check: 'slack_mcp',
    why: 'Lets the bot read/search your Slack as you (e.g. "what did I commit to in the last hour"). Authenticate once; the token lands in your login Keychain and headless sessions reuse it.',
    steps: [
      { title: 'Register the hosted Slack MCP', code: 'claude mcp add --transport http --scope user slack https://mcp.slack.com/mcp' },
      { title: 'Authenticate as yourself (browser)', body: 'Open Claude, then: /mcp → slack → Authenticate.', code: 'claude' },
    ],
  },
  {
    id: 'salesforce', label: 'Salesforce orgs', check: 'salesforce',
    why: 'Lets the bot query/describe orgs via the sf CLI. Authenticate each org once; tokens are machine-wide so the bot reuses them.',
    steps: [
      { title: 'Install the Salesforce CLI', code: 'npm install -g @salesforce/cli' },
      { title: 'Authenticate each org (browser; repeat per org)', code: 'sf org login web --alias my-org' },
      { title: 'Install the read-only skill', body: 'Copy a `salesforce/SKILL.md` to `~/.claude/skills/salesforce/SKILL.md` (read-only by instruction; always targets an explicit --target-org).' },
    ],
  },
  {
    id: 'drive', label: 'Google Drive', check: 'drive',
    why: 'Projects can bind a Google Drive folder; Claude reads/writes it with normal file tools — no API/OAuth.',
    steps: [
      { title: 'Install Google Drive for Desktop', body: 'Download from google.com/drive/download and sign in — it mounts under ~/Library/CloudStorage/. Then bind a folder to a project from the Projects tab.' },
    ],
  },
  {
    id: 'outlook', label: 'Outlook (Home tab)', check: 'outlook',
    why: 'Optional. Powers the Home tab inbox + calendar via the outlook skill. Requires Outlook for Mac in Legacy mode.',
    steps: [
      { title: 'Install the skill + switch Outlook to Legacy mode', body: 'Copy the outlook skill to ~/.claude/skills/outlook/, turn off "New Outlook" in Outlook for Mac, and allow the macOS Automation prompt on first run. Then verify:', code: 'bash ~/.claude/skills/outlook/mail.sh mode   # should print: legacy' },
    ],
  },
  {
    id: 'memory', label: 'Long-term memory (MemPalace)', check: 'memory', optional: true, toggle: true,
    why: 'Optional local memory + recall (github.com/mempalace/mempalace). Fully offline — local embeddings, no API key, no LLM. When on, the bot & agents auto-recall from your project notes and files.',
    steps: [
      { title: 'Turn it on (one command, from the repo root)', body: 'Installs MemPalace, indexes your workspaces + Claude sessions, sets MEMORY_ENABLED=true, and restarts the bot + runtime. A scheduled job re-mines hourly.', code: './scripts/install-mempalace.sh' },
      { title: 'Or use the toggle above', body: 'Once installed you can flip memory on/off here anytime.' },
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
      checkServices(), checkSlackScopes(), checkSlackMcp(), checkSalesforce(), Promise.resolve(checkDrive()), checkOutlook(), checkMemory(),
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
  memory: checkMemory,
};
router.get('/status/:id', async (req, res) => {
  const fn = CHECKS[req.params.id];
  if (!fn) return res.status(404).json({ error: 'unknown check' });
  try { res.json(await fn()); } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /memory/toggle — enable/disable the optional memory feature for the assistant.
// Flips MEMORY_ENABLED in the shared .env and restarts the bot + runtime so they pick it up.
router.post('/memory/toggle', (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  try {
    setEnvFlag('MEMORY_ENABLED', enabled ? 'true' : 'false');
    const uid = typeof process.getuid === 'function' ? process.getuid() : '';
    for (const svc of ['bot', 'runtime']) {
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
