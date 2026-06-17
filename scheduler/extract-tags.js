'use strict';

const fs = require('fs');
const path = require('path');

const VAULT = `${process.env.HOME}/claude-workspaces/bak`;
const OUT   = path.join(VAULT, '_agent_data/tags.json');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '.trash') return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : full;
  }).filter(f => f.endsWith('.md'));
}

function parseFrontmatterTags(fmContent) {
  const tags = [];
  const lines = fmContent.split('\n');
  let inTags = false;

  for (const line of lines) {
    // Multi-line list: tags: (nothing after)
    if (/^tags:\s*$/.test(line)) {
      inTags = true;
      continue;
    }
    // Inline array: tags: [foo, bar] or tags: ["foo", "bar"]
    if (/^tags:\s*\[/.test(line)) {
      const inner = line.match(/^tags:\s*\[([^\]]*)\]/);
      if (inner) {
        tags.push(...inner[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
      }
      return tags;
    }
    // Single inline value: tags: foo
    if (/^tags:\s*\S/.test(line)) {
      tags.push(line.replace(/^tags:\s*/, '').trim().replace(/^['"]|['"]$/g, ''));
      return tags;
    }

    if (inTags) {
      const item = line.match(/^[ \t]+-[ \t]+(.+)$/);
      if (item) {
        tags.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
      } else if (/^\S/.test(line) && line.includes(':')) {
        inTags = false;
      }
    }
  }

  return tags;
}

const files = walk(VAULT);
const tagMap = {};

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) continue;

  const rel = path.relative(VAULT, file);
  for (const tag of parseFrontmatterTags(fm[1])) {
    if (tag) (tagMap[tag] ??= []).push(rel);
  }
}

const sorted = Object.keys(tagMap).sort((a, b) => a.localeCompare(b));

fs.writeFileSync(OUT, JSON.stringify(sorted, null, 2));

console.log(`Extracted ${sorted.length} tags from ${files.length} files → ${OUT}`);
