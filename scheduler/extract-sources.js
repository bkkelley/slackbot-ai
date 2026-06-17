'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_DIR = `${process.env.HOME}/claude-workspaces/bak/Source`;
const OUT        = `${process.env.HOME}/claude-workspaces/bak/_agent_data/source-files.json`;

const files = fs.readdirSync(SOURCE_DIR, { withFileTypes: true })
  .filter(e => e.isFile() && e.name.endsWith('.md'))
  .map(e => e.name.replace(/\.md$/, ''))
  .sort((a, b) => a.localeCompare(b));

fs.writeFileSync(OUT, JSON.stringify(files, null, 2));

console.log(`Extracted ${files.length} files from Source → ${OUT}`);
