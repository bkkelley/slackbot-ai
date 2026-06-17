const express = require('express');
const fs = require('fs');
const path = require('path');
const { vaultPath } = require('../../shared/config');

const router = express.Router();

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key) fm[key] = val;
  }
  return fm;
}

// GET /agents/api/activity?limit=50
router.get('/', (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const cardDir = path.join(vaultPath, 'Card');
    if (!fs.existsSync(cardDir)) return res.json([]);

    const results = [];
    for (const filename of fs.readdirSync(cardDir)) {
      if (!filename.endsWith('.md')) continue;
      const filePath = path.join(cardDir, filename);
      let content;
      try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
      const fm = parseFrontmatter(content);
      if (fm['card-type'] !== 'Agent Log') continue;

      const mtime = fs.statSync(filePath).mtime;
      // Parse filename: "<Agent> - <Action> - <date> <time>.md"
      const base = filename.replace('.md', '');
      const parts = base.split(' - ');
      const agent = parts[0] || '';
      const dateTime = parts[parts.length - 1] || '';
      const action = parts.slice(1, -1).join(' - ');

      results.push({
        filename,
        agent,
        action,
        date: dateTime,
        mtime: mtime.toISOString(),
        summary: fm['summary'] || fm['body'] || null,
        slackTs: fm['slack-ts'] ? fm['slack-ts'].replace(/"/g, '') : null,
        ok: fm['ok'] !== 'false',
      });
    }

    results.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json(results.slice(0, limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
