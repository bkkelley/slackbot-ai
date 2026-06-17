const express = require('express');
const fs = require('fs');
const path = require('path');
const { vaultPath } = require('../../shared/config');

const router = express.Router();

const INBOX_DIR = path.join(vaultPath, 'Inbox');
const RUNTIME_URL = `http://127.0.0.1:${process.env.RUNTIME_HTTP_PORT || '3457'}`;
const SHARED_SECRET = process.env.BOT_RUNTIME_SHARED_SECRET || '';

// GET /agents/api/inbox
router.get('/', (req, res) => {
  try {
    if (!fs.existsSync(INBOX_DIR)) return res.json([]);
    const now = Date.now();
    const files = fs.readdirSync(INBOX_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const filePath = path.join(INBOX_DIR, f);
        const stat = fs.statSync(filePath);
        return {
          filename: f,
          path: filePath,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          ageMs: now - stat.mtime.getTime(),
        };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /agents/api/inbox/process
// Body: { file? } — specific file path, or omit to process all
router.post('/process', (req, res) => {
  try {
    const { file } = req.body || {};
    let targets = [];

    if (file) {
      if (!fs.existsSync(file)) return res.status(404).json({ error: 'File not found' });
      targets = [file];
    } else {
      if (!fs.existsSync(INBOX_DIR)) return res.json({ dispatched: 0 });
      targets = fs.readdirSync(INBOX_DIR)
        .filter(f => f.endsWith('.md'))
        .map(f => path.join(INBOX_DIR, f));
    }

    for (const target of targets) {
      fetch(`${RUNTIME_URL}/api/agents/inbox-processor/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bot-Auth': SHARED_SECRET },
        body: JSON.stringify({ action: 'Process', mode: 'async', toolset: 'default', files: [target] }),
      }).catch(() => {});
    }

    res.json({ dispatched: targets.length, files: targets.map(t => path.basename(t)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
