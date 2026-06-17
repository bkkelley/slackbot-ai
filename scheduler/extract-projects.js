'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = `${process.env.HOME}/claude-workspaces/bak/Project`;
const OUT         = `${process.env.HOME}/claude-workspaces/bak/_agent_data/project-files.json`;

const files = fs.readdirSync(PROJECT_DIR, { withFileTypes: true })
  .filter(e => e.isFile() && e.name.endsWith('.md'))
  .map(e => e.name.replace(/\.md$/, ''))
  .sort((a, b) => a.localeCompare(b));

fs.writeFileSync(OUT, JSON.stringify({
  extractedAt: new Date().toISOString(),
  count: files.length,
  files,
}, null, 2));

console.log(`Extracted ${files.length} files from Project → ${OUT}`);
