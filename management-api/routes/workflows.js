const express = require('express');
const fs = require('fs');
const path = require('path');
const { vaultPath, baseDirectory } = require('../../shared/config');
const { assertSafeSegment, isSafeSegment, optionalScope, safeJoin, safeMarkdownFile, handleHttpError } = require('../../shared/path-guard');

const router = express.Router();
const RUNTIME_API_URL = `http://127.0.0.1:${process.env.RUNTIME_HTTP_PORT || '3457'}`;
const BOT_RUNTIME_SHARED_SECRET = process.env.BOT_RUNTIME_SHARED_SECRET || '';

function workflowsDir(scope = null) {
  if (scope) return safeJoin(baseDirectory, optionalScope(scope), '.agents', 'workflows');
  return safeJoin(vaultPath, '_workflows');
}

function workflowFilePath(name, scope = null) {
  return safeMarkdownFile(workflowsDir(scope), name, 'workflow name');
}

function readWorkflowList(scope = null) {
  const dir = workflowsDir(scope);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const name = f.slice(0, -3);
      const content = fs.readFileSync(path.join(dir, f), 'utf8');
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      let steps = 0;
      if (match) {
        const hits = match[1].match(/^\s*-\s+type:/gm);
        steps = hits ? hits.length : 0;
      }
      return { name, steps, scope };
    });
}

// GET / — list all workflows grouped by scope
router.get('/', (req, res) => {
  try {
    const groups = [];

    // Global
    const globalItems = readWorkflowList(null);
    groups.push({ scope: null, label: 'Global', workflows: globalItems });

    // Per-workspace
    if (fs.existsSync(baseDirectory)) {
      for (const d of fs.readdirSync(baseDirectory, { withFileTypes: true })) {
        if (!d.isDirectory() && !d.isSymbolicLink()) continue;
        if (d.name.startsWith('.')) continue;
        if (!isSafeSegment(d.name)) continue;
        const items = readWorkflowList(d.name);
        if (items.length > 0) {
          groups.push({ scope: d.name, label: d.name, workflows: items });
        }
      }
    }

    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:name — get workflow content
router.get('/:name', (req, res) => {
  try {
    const scope = optionalScope(req.query.scope);
    const filePath = workflowFilePath(req.params.name, scope);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Workflow not found' });
    res.json({ content: fs.readFileSync(filePath, 'utf8'), path: filePath });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// PUT /:name — save workflow
router.put('/:name', (req, res) => {
  try {
    const scope = optionalScope(req.query.scope);
    const { content } = req.body;
    if (content === undefined) return res.status(400).json({ error: 'content is required' });
    const filePath = workflowFilePath(req.params.name, scope);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// POST / — create new workflow
router.post('/', (req, res) => {
  try {
    const scope = optionalScope(req.body.scope);
    const name = assertSafeSegment(req.body.name, 'workflow name');
    const filePath = workflowFilePath(name, scope);
    if (fs.existsSync(filePath)) return res.status(409).json({ error: 'Workflow already exists' });
    const template = typeof req.body.content === 'string' && req.body.content.trim()
      ? req.body.content
      : `---
name: ${name}
steps:
  - type: agent
    agent: AgentName
    action: Action Name
    toolset: default
---

# ${name}

Description of what this workflow does.
`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, template, 'utf8');
    res.status(201).json({ ok: true, name, scope });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// DELETE /:name — delete workflow
router.delete('/:name', (req, res) => {
  try {
    const scope = optionalScope(req.query.scope);
    const filePath = workflowFilePath(req.params.name, scope);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Workflow not found' });
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// POST /:name/run — dispatch workflow as async job, returns jobId for streaming
router.post('/:name/run', async (req, res) => {
  try {
    const {
      scope,
      model,
      toolset,
      outputChannel,
      threadId,
      files,
      replyText,
      workflowContext,
      mode,
    } = req.body || {};
    const workflowName = assertSafeSegment(req.params.name, 'workflow name');
    const jobRequest = {
      workflow: workflowName,
      mode: mode === 'preview' ? 'preview' : 'async',
      trigger: 'manual',
      scope: optionalScope(scope) || undefined,
      model: model || undefined,
      toolset: toolset || 'default',
      outputChannel: outputChannel && outputChannel.platform && outputChannel.id ? outputChannel : undefined,
      threadId: threadId || undefined,
      files: files ? (Array.isArray(files) ? files : [files]) : undefined,
      replyText: replyText || undefined,
      workflowContext: workflowContext || replyText || undefined,
    };
    const response = await fetch(`${RUNTIME_API_URL}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bot-Auth': BOT_RUNTIME_SHARED_SECRET },
      body: JSON.stringify(jobRequest),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Failed to reach runtime: ${err.message}` });
  }
});

module.exports = router;
