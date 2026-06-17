const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  actionFilePathForWrite,
  findAction,
  formatActionTemplate,
  listActionGroups,
  listActionsForAgent,
  resolveActionFilePath,
} = require('../../shared/action-resolver');
const { assertSafeSegment, optionalScope, handleHttpError } = require('../../shared/path-guard');

const router = express.Router();

// GET / — list all actions grouped by scope and agent
router.get('/', (req, res) => {
  try {
    res.json(listActionGroups());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:agent — list actions for an agent
router.get('/:agent', (req, res) => {
  try {
    const scope = optionalScope(req.query.scope);
    res.json(listActionsForAgent(req.params.agent, scope).map(action => ({ name: action.name })));
  } catch (err) {
    handleHttpError(res, err);
  }
});

// GET /:agent/:action — get action content
router.get('/:agent/:action', (req, res) => {
  try {
    const scope = optionalScope(req.query.scope);
    const action = findAction(req.params.agent, req.params.action, scope);
    const filePath = action?.filePath;
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Action not found' });
    res.json({
      content: fs.readFileSync(filePath, 'utf8'),
      path: filePath,
      agents: action.agents,
      legacy: action.legacy,
      source: action.source,
    });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// PUT /:agent/:action — save action content
router.put('/:agent/:action', (req, res) => {
  try {
    const scope = optionalScope(req.query.scope);
    const { content } = req.body;
    if (content === undefined) return res.status(400).json({ error: 'content is required' });
    const filePath = resolveActionFilePath(req.params.agent, req.params.action, scope)
      || actionFilePathForWrite(req.params.action, scope);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// POST /:agent — create new action template
router.post('/:agent', (req, res) => {
  try {
    const scope = optionalScope(req.query.scope);
    const name = assertSafeSegment(req.body.name, 'action name');
    const agents = Array.isArray(req.body.agents) && req.body.agents.length > 0
      ? req.body.agents.map(agent => assertSafeSegment(agent, 'agent name'))
      : [assertSafeSegment(req.params.agent, 'agent name')];
    if (resolveActionFilePath(req.params.agent, name, scope)) {
      return res.status(409).json({ error: 'Action already exists' });
    }
    const filePath = actionFilePathForWrite(name, scope);
    if (fs.existsSync(filePath)) return res.status(409).json({ error: 'Action already exists' });
    const template = formatActionTemplate(agents, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, template, 'utf8');
    res.status(201).json({ ok: true, name });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// DELETE /:agent/:action — delete action template
router.delete('/:agent/:action', (req, res) => {
  try {
    const scope = optionalScope(req.query.scope);
    const filePath = resolveActionFilePath(req.params.agent, req.params.action, scope);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Action not found' });
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    handleHttpError(res, err);
  }
});

module.exports = router;
