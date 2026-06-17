const express = require('express');
const fs = require('fs');
const path = require('path');
const { listAgents, getAgent, updateAgentFrontmatter, parseFrontmatter, projectAgentDir, projectClaudeAgentDir } = require('../../shared/vault');
const { createAgent, deleteAgent } = require('../../shared/scaffold');
const { baseDirectory, vaultPath } = require('../../shared/config');
const { assertSafeSegment, optionalScope, safeJoin, handleHttpError } = require('../../shared/path-guard');
const { listActionsForAgent } = require('../../shared/action-resolver');

const router = express.Router();

function agentFiles(name, scope = null) {
  const safeName = assertSafeSegment(name, 'agent name');
  const safeScope = optionalScope(scope);
  if (scope) {
    // Project agent: only the agent definition file itself
    const filePath = getAgent(safeName, safeScope)?.filePath || safeJoin(projectClaudeAgentDir(safeScope), `${safeName}.md`);
    return { 'Agent.md': filePath };
  }
  const workspaceDir = safeJoin(baseDirectory, safeName.toLowerCase());
  return {
    'Agent.md': getAgent(safeName)?.filePath,
    'CLAUDE.md': path.join(workspaceDir, 'CLAUDE.md'),
    'settings.json': path.join(workspaceDir, '.claude', 'settings.json'),
  };
}

router.get('/', (req, res) => {
  try {
    res.json(listAgents());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:name', (req, res) => {
  try {
    const scope = optionalScope(req.query.scope);
    const agent = getAgent(req.params.name, scope);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(agent);
  } catch (err) {
    handleHttpError(res, err);
  }
});

router.post('/', (req, res) => {
  try {
    const { name, instructions, model, cadence, triggerType, triggerConfig, scope } = req.body;
    if (!name || !instructions) return res.status(400).json({ error: 'name and instructions are required' });
    const safeName = assertSafeSegment(name, 'agent name');
    const safeScope = optionalScope(scope);
    if (safeScope) {
      // Project agent — create file directly in workspace .agents/
      const { writeAgent, stringifyFrontmatter } = require('../../shared/vault');
      const frontmatter = {
        fileClass: 'Agent',
        'agent-name': safeName,
        status: 'Active',
        model: model || 'claude-haiku-4-5-20251001',
        cadence: cadence || 'On demand',
      };
      writeAgent(safeName, frontmatter, instructions + '\n', safeScope);
      res.status(201).json({ name: safeName, scope: safeScope });
    } else {
      const result = createAgent({ name: safeName, instructions, model, cadence, triggerType, triggerConfig });
      res.status(201).json(result);
    }
  } catch (err) {
    handleHttpError(res, err);
  }
});

router.patch('/:name', (req, res) => {
  try {
    const scope = optionalScope(req.query.scope);
    updateAgentFrontmatter(req.params.name, req.body, scope);
    res.json({ ok: true });
  } catch (err) {
    handleHttpError(res, err);
  }
});

router.get('/:name/files', (req, res) => {
  try {
    const scope = optionalScope(req.query.scope);
    const files = agentFiles(req.params.name, scope);
    const result = {};
    for (const [label, filePath] of Object.entries(files)) {
      if (filePath && fs.existsSync(filePath)) {
        result[label] = { content: fs.readFileSync(filePath, 'utf8'), path: filePath };
      } else {
        result[label] = { content: '', path: filePath || null, missing: true };
      }
    }
    res.json(result);
  } catch (err) {
    handleHttpError(res, err);
  }
});

router.patch('/:name/files', (req, res) => {
  try {
    const scope = optionalScope(req.query.scope);
    const { filename, content } = req.body;
    if (!filename || content === undefined) return res.status(400).json({ error: 'filename and content are required' });
    const files = agentFiles(req.params.name, scope);
    const filePath = files[filename];
    if (!filePath) return res.status(400).json({ error: `Unknown file: ${filename}` });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    handleHttpError(res, err);
  }
});

router.get('/:name/actions', (req, res) => {
  try {
    const scope = optionalScope(req.query.scope);
    const actions = listActionsForAgent(req.params.name, scope).map(action => action.name);
    res.json(actions);
  } catch (err) {
    handleHttpError(res, err);
  }
});

router.get('/:name/overview', (req, res) => {
  try {
    const name = assertSafeSegment(req.params.name, 'agent name');
    const scope = optionalScope(req.query.scope);
    const agents = listAgents();
    const agent = agents.find(a => a.name.toLowerCase() === name.toLowerCase() && (scope ? a.scope === scope : !a.scope))
                || agents.find(a => a.name.toLowerCase() === name.toLowerCase());

    // Workspace
    const workspacePath = safeJoin(baseDirectory, name.toLowerCase());

    // Recent log cards — filename prefix: "<Name> - "
    const cardDir = path.join(vaultPath, 'Card');
    const recentCards = [];
    if (fs.existsSync(cardDir)) {
      const prefix = `${name} - `;
      const files = fs.readdirSync(cardDir)
        .filter(f => f.startsWith(prefix) && f.endsWith('.md'))
        .sort().reverse().slice(0, 5);
      for (const filename of files) {
        try {
          const content = fs.readFileSync(path.join(cardDir, filename), 'utf8');
          const fm = parseFrontmatter(content);
          const parts = filename.replace('.md', '').split(' - ');
          const action = parts.slice(1, -1).join(' - ');
          const date = parts[parts.length - 1];
          recentCards.push({
            filename,
            action,
            date,
            summary: fm['summary'] || fm['body'] || null,
            slackTs: fm['slack-ts'] ? fm['slack-ts'].replace(/"/g, '') : null,
          });
        } catch {}
      }
    }

    res.json({
      workspace: { path: workspacePath, exists: fs.existsSync(workspacePath) },
      recentCards,
    });
  } catch (err) {
    handleHttpError(res, err);
  }
});

router.get('/:name/shell', (req, res) => {
  try {
    const name = assertSafeSegment(req.params.name, 'agent name');
    const scriptPath = safeJoin(vaultPath, 'Meta', `run-${name.toLowerCase()}.sh`);
    if (fs.existsSync(scriptPath)) {
      res.json({ exists: true, path: scriptPath, content: fs.readFileSync(scriptPath, 'utf8') });
    } else {
      res.json({ exists: false, path: scriptPath });
    }
  } catch (err) {
    handleHttpError(res, err);
  }
});

router.delete('/:name', (req, res) => {
  try {
    const scope = optionalScope(req.query.scope);
    if (scope) {
      const { deleteAgentFile } = require('../../shared/vault');
      deleteAgentFile(req.params.name, scope);
      return res.json({ ok: true });
    }
    const { removeWorkspace = false } = req.body || {};
    const result = deleteAgent(req.params.name, { removeWorkspace });
    res.json(result);
  } catch (err) {
    handleHttpError(res, err);
  }
});

module.exports = router;
