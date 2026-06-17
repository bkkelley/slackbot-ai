const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const toolsetsPath = path.join(__dirname, '../../agent-runtime/toolsets.json');

// GET / — return toolsets as [{name, tools}]
router.get('/', (req, res) => {
  try {
    const raw = fs.existsSync(toolsetsPath)
      ? JSON.parse(fs.readFileSync(toolsetsPath, 'utf8'))
      : {};
    const toolsets = Object.entries(raw).map(([name, tools]) => ({ name, tools }));
    res.json(toolsets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT / — save [{name, tools}] array
router.put('/', (req, res) => {
  try {
    const { toolsets } = req.body;
    if (!Array.isArray(toolsets)) return res.status(400).json({ error: 'toolsets must be an array' });
    const obj = {};
    for (const { name, tools } of toolsets) {
      if (name && tools) obj[name.trim()] = tools.trim();
    }
    fs.writeFileSync(toolsetsPath, JSON.stringify(obj, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
