const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  listPersonaGroups,
  personaFilePathForWrite,
  resolvePersonaFilePath,
} = require('../../shared/persona-resolver');
const { assertSafeSegment, optionalScope, handleHttpError } = require('../../shared/path-guard');

const router = express.Router();

// GET / — list all personas grouped by scope
router.get('/', (req, res) => {
  try {
    res.json(listPersonaGroups());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:name — get persona content
router.get('/:name', (req, res) => {
  try {
    const scope = optionalScope(req.query.scope);
    const filePath = resolvePersonaFilePath(req.params.name, scope);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Persona not found' });
    res.json({ content: fs.readFileSync(filePath, 'utf8'), path: filePath });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// PUT /:name — save persona
router.put('/:name', (req, res) => {
  try {
    const scope = optionalScope(req.query.scope);
    const { content } = req.body;
    if (content === undefined) return res.status(400).json({ error: 'content is required' });
    const filePath = resolvePersonaFilePath(req.params.name, scope)
      || personaFilePathForWrite(req.params.name, scope);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// POST / — create new persona
router.post('/', (req, res) => {
  try {
    const scope = optionalScope(req.body.scope);
    const name = assertSafeSegment(req.body.name, 'persona name');
    if (resolvePersonaFilePath(name, scope)) return res.status(409).json({ error: 'Persona already exists' });
    const filePath = personaFilePathForWrite(name, scope);
    const template = `---
name: ${name}
---

# ${name}

Voice, tone, and behavioral constraints for this persona.

## Voice

Describe the persona's communication style.

## Constraints

- What the persona should never do
`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, template, 'utf8');
    res.status(201).json({ ok: true, name, scope });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// DELETE /:name — delete persona
router.delete('/:name', (req, res) => {
  try {
    const scope = optionalScope(req.query.scope);
    const filePath = resolvePersonaFilePath(req.params.name, scope);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Persona not found' });
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    handleHttpError(res, err);
  }
});

module.exports = router;
