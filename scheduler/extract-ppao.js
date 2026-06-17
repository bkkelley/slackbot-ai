'use strict';

const fs = require('fs');
const path = require('path');

const PPAO_DIR = `${process.env.HOME}/claude-workspaces/bak/PPAO`;
const OUT      = `${process.env.HOME}/claude-workspaces/bak/_agent_data/ppao-files.json`;

const files = fs.readdirSync(PPAO_DIR, { withFileTypes: true })
  .filter(e => e.isFile() && e.name.endsWith('.md'))
  .map(e => e.name.replace(/\.md$/, ''))
  .sort((a, b) => a.localeCompare(b));

fs.writeFileSync(OUT, JSON.stringify(files, null, 2));

console.log(`Extracted ${files.length} files from PPAO → ${OUT}`);
