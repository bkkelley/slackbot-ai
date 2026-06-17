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

// GET /status — readiness of every integration (cached 20s)
let _cache = { at: 0, data: null };
router.get('/status', async (req, res) => {
  try {
    if (_cache.data && Date.now() - _cache.at < 20000 && !req.query.fresh) return res.json(_cache.data);
    const items = await Promise.all([
      checkServices(), checkSlackScopes(), checkSlackMcp(), checkSalesforce(), Promise.resolve(checkDrive()), checkOutlook(),
    ]);
    const summary = { ok: items.filter((c) => c.status === 'ok').length, warn: items.filter((c) => c.status === 'warn').length, missing: items.filter((c) => c.status === 'missing' || c.status === 'error').length, total: items.length };
    _cache = { at: Date.now(), data: { items, summary } };
    res.json(_cache.data);
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
