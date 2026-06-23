const express = require('express');
const fs = require('fs');
const path = require('path');
const { baseDirectory } = require('../../shared/config');
const { countProjectAgents } = require('../../shared/vault');
const { countWorkspaceActions } = require('../../shared/action-resolver');
const { countWorkspacePersonas } = require('../../shared/persona-resolver');
const { assertSafeSegment, safeJoin, handleHttpError } = require('../../shared/path-guard');

const router = express.Router();

function countMd(dir) {
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.md')).length;
  } catch { return 0; }
}

function countSkills(dir) {
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.'))
      .filter(d => fs.existsSync(path.join(dir, d.name, 'SKILL.md')))
      .length;
  } catch { return 0; }
}

function countProjectSkills(projectDir) {
  const seen = new Set();
  for (const dir of [
    path.join(projectDir, '.claude', 'skills'),
    path.join(projectDir, '.agents', 'skills'),
  ]) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if ((d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.') && fs.existsSync(path.join(dir, d.name, 'SKILL.md'))) {
          seen.add(d.name);
        }
      }
    } catch {}
  }
  return seen.size;
}

// ---- project bindings (channel-projects.json reverse index + per-project project.json manifest) ----
const isSfId = (v) => /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(String(v || '').trim());
function loadChannelMap() {
  try { return JSON.parse(fs.readFileSync(path.join(baseDirectory, 'channel-projects.json'), 'utf8')); }
  catch { return {}; }
}
function manifestPath(name) { return path.join(baseDirectory, name, 'project.json'); }
function loadManifest(name) {
  try { return JSON.parse(fs.readFileSync(manifestPath(name), 'utf8')); }
  catch { return { name }; }
}
function channelsByProject() {
  const out = {};
  for (const [cid, proj] of Object.entries(loadChannelMap())) (out[proj] = out[proj] || []).push(cid);
  return out;
}
function bindingsFor(name, byProject) {
  const m = loadManifest(name);
  const sf = m.salesforce || {};
  return {
    channels: Array.from(new Set([...(m.channels || []), ...((byProject || {})[name] || [])])),
    salesforce: { org: sf.org || '', accountId: sf.accountId || '', projectId: sf.projectId || '' },
    drivePath: m.drivePath || '',
    aliases: Array.isArray(m.aliases) ? m.aliases : [],
  };
}
function saveChannelMap(map) {
  fs.mkdirSync(baseDirectory, { recursive: true });
  fs.writeFileSync(path.join(baseDirectory, 'channel-projects.json'), JSON.stringify(map, null, 2) + '\n');
}
function saveManifest(name, m) {
  fs.mkdirSync(path.join(baseDirectory, name), { recursive: true });
  fs.writeFileSync(manifestPath(name), JSON.stringify(m, null, 2) + '\n');
}
// Slack conversation IDs: channels C…, groups/private G…, DMs D… (uppercase alphanumeric).
const isChannelId = (v) => /^[CDG][A-Z0-9]{6,}$/i.test(String(v || '').trim());

// Reserved subdirectories of baseDirectory that are system infrastructure, not projects:
// `system` is the automation code, co-located under the registry root after the layout move.
const RESERVED_PROJECT_NAMES = new Set(['system']);

// GET / — list all workspace directories with counts + project bindings
router.get('/', (req, res) => {
  try {
    if (!fs.existsSync(baseDirectory)) return res.json([]);
    const byProject = channelsByProject();
    const projects = fs.readdirSync(baseDirectory, { withFileTypes: true })
      .filter(d => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.') && !RESERVED_PROJECT_NAMES.has(d.name))
      .map(d => {
        const projectDir = path.join(baseDirectory, d.name);
        const agentsDir = path.join(baseDirectory, d.name, '.agents');
        return {
          name: d.name,
          agents:    countProjectAgents(d.name),
          actions:   countWorkspaceActions(d.name),
          workflows: countMd(path.join(agentsDir, 'workflows')),
          personas:  countWorkspacePersonas(d.name),
          skills:    countProjectSkills(projectDir),
          ...bindingsFor(d.name, byProject),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /channel-directory — channels for the picker, via users.conversations. Cached 5 min.
// Preferred token is the user token (xoxp): it returns every channel the OWNER is in, including
// ones the bot hasn't been invited to. We separately pull the bot's own memberships (xoxb) and
// flag each channel with is_bot_member, so the UI can mark where the bot will actually respond
// (it only acts on @mention in channels it's a member of) vs. read-only-via-user-token channels.
// Falls back to bot-only if no user token. Degrades gracefully: returns { ok:false, error } (e.g.
// missing_scope) so the UI falls back to paste-ID.
let _chanCache = { at: 0, data: null };

// Returns { ok, channels:[{id,name,is_private}], error } for one token's users.conversations.
async function fetchConversations(token) {
  if (!token) return { ok: false, error: 'no_token' };
  const channels = [];
  let cursor = '';
  for (let i = 0; i < 25; i++) {
    const url = new URL('https://slack.com/api/users.conversations');
    url.searchParams.set('types', 'public_channel,private_channel');
    url.searchParams.set('exclude_archived', 'true');
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = await resp.json();
    if (!j.ok) return { ok: false, error: j.error };
    for (const c of (j.channels || [])) channels.push({ id: c.id, name: c.name, is_private: !!c.is_private });
    cursor = (j.response_metadata && j.response_metadata.next_cursor) || '';
    if (!cursor) break;
  }
  return { ok: true, channels };
}

async function listSlackChannels() {
  const userToken = process.env.SLACK_USER_TOKEN;
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!userToken && !botToken) return { ok: false, error: 'no_token' };

  // Bot's own memberships → the set of channels where the bot will actually respond.
  const botResult = botToken ? await fetchConversations(botToken) : { ok: false, channels: [] };
  const botIds = new Set((botResult.channels || []).map((c) => c.id));

  // Prefer the user token for the full list (every channel the owner is in). Fall back to bot-only.
  let base = userToken ? await fetchConversations(userToken) : botResult;
  let source = userToken ? 'user' : 'bot';
  if (userToken && !base.ok) {
    // User token failed (e.g. missing scope) — degrade to bot-only rather than erroring out.
    base = botResult;
    source = 'bot';
  }
  if (!base.ok) return { ok: false, error: base.error };

  const channels = base.channels
    .map((c) => ({ ...c, is_bot_member: botIds.has(c.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, source, channels };
}

router.get('/channel-directory', async (req, res) => {
  try {
    if (_chanCache.data && Date.now() - _chanCache.at < 5 * 60 * 1000) return res.json(_chanCache.data);
    const result = await listSlackChannels();
    if (result.ok) _chanCache = { at: Date.now(), data: result };
    res.json(result.ok ? result : { ok: false, error: result.error, channels: [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, channels: [] });
  }
});

// POST /:name/channels — map a Slack channel to this project (writes channel-projects.json + manifest)
router.post('/:name/channels', (req, res) => {
  try {
    const safeName = assertSafeSegment(req.params.name, 'project name');
    const channelId = ((req.body && req.body.channelId) || '').trim();
    if (!isChannelId(channelId)) {
      return res.status(400).json({ error: 'Enter a valid Slack channel ID (e.g. C0AB12CDE).' });
    }
    safeJoin(baseDirectory, safeName); // path-guard the project name
    const map = loadChannelMap();
    map[channelId] = safeName; // a channel maps to exactly one project; reassigns if it was elsewhere
    saveChannelMap(map);
    const m = loadManifest(safeName);
    m.name = m.name || safeName;
    m.channels = Array.from(new Set([...(m.channels || []), channelId]));
    saveManifest(safeName, m);
    res.json({ ok: true, ...bindingsFor(safeName, channelsByProject()) });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// DELETE /:name/channels/:channelId — unmap a channel from this project
router.delete('/:name/channels/:channelId', (req, res) => {
  try {
    const safeName = assertSafeSegment(req.params.name, 'project name');
    const channelId = req.params.channelId;
    const map = loadChannelMap();
    if (map[channelId] === safeName) { delete map[channelId]; saveChannelMap(map); }
    const m = loadManifest(safeName);
    if (Array.isArray(m.channels)) { m.channels = m.channels.filter(c => c !== channelId); saveManifest(safeName, m); }
    res.json({ ok: true, ...bindingsFor(safeName, channelsByProject()) });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// PUT /:name/bindings — update a project's Salesforce + Drive bindings (project.json manifest)
router.put('/:name/bindings', (req, res) => {
  try {
    const safeName = assertSafeSegment(req.params.name, 'project name');
    const dir = safeJoin(baseDirectory, safeName);
    const { salesforce, drivePath, aliases } = req.body || {};
    if (salesforce) {
      if (salesforce.accountId && !isSfId(salesforce.accountId)) {
        return res.status(400).json({ error: 'Account Id must be a 15- or 18-char Salesforce ID' });
      }
      if (salesforce.projectId && !isSfId(salesforce.projectId)) {
        return res.status(400).json({ error: 'Project__c Id must be a 15- or 18-char Salesforce ID' });
      }
    }
    fs.mkdirSync(dir, { recursive: true });
    const m = loadManifest(safeName);
    m.name = m.name || safeName;
    if (salesforce !== undefined) {
      m.salesforce = {
        org: (salesforce.org || '').trim(),
        accountId: (salesforce.accountId || '').trim(),
        projectId: (salesforce.projectId || '').trim(),
      };
    }
    // strip surrounding quotes — paths with spaces/commas are often pasted shell-quoted
    if (drivePath !== undefined) m.drivePath = (drivePath || '').trim().replace(/^["']|["']$/g, '');
    // aliases: accept a comma/newline-separated string or an array
    if (aliases !== undefined) {
      const list = Array.isArray(aliases) ? aliases : String(aliases || '').split(/[,\n]/);
      m.aliases = list.map((a) => String(a).trim()).filter(Boolean);
    }
    fs.writeFileSync(manifestPath(safeName), JSON.stringify(m, null, 2) + '\n');
    res.json({ ok: true, name: safeName, ...bindingsFor(safeName, channelsByProject()) });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// POST / — create a new project workspace
router.post('/', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      return res.status(400).json({ error: 'name is required and must be alphanumeric (hyphens/underscores ok)' });
    }
    const safeName = assertSafeSegment(name, 'project name');
    const projectDir = safeJoin(baseDirectory, safeName);
    if (fs.existsSync(projectDir)) {
      return res.status(409).json({ error: 'Project already exists' });
    }
    fs.mkdirSync(safeJoin(projectDir, '.agents'), { recursive: true });
    res.status(201).json({ ok: true, name: safeName });
  } catch (err) {
    handleHttpError(res, err);
  }
});

module.exports = router;
