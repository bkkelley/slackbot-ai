const fs = require('fs');
const path = require('path');
const os = require('os');
const { vaultPath, baseDirectory } = require('./config');
const { assertSafeSegment, isSafeSegment, optionalScope, safeJoin, safeMarkdownFile } = require('./path-guard');

const AGENTS_DIR = path.join(vaultPath, 'Agent');
const CLAUDE_AGENT_DIRS = [
  path.join(os.homedir(), '.claude', 'agents'),
  path.join(baseDirectory, '.claude:agents'),
];

function projectAgentDir(workspace) {
  return safeJoin(baseDirectory, assertSafeSegment(workspace, 'scope'), '.agents');
}
function projectClaudeAgentDir(workspace) {
  return safeJoin(baseDirectory, assertSafeSegment(workspace, 'scope'), '.claude', 'agents');
}
function projectAgentFilePath(workspace, name) {
  return safeMarkdownFile(projectClaudeAgentDir(workspace), name, 'agent name');
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim().replace(/^"|"$/g, '');
    if (key && val) result[key] = val;
  }
  return result;
}

function stringifyFrontmatter(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function getBody(content) {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '').trimStart();
}

function parseAgentFile(filePath, scope = null) {
  const content = fs.readFileSync(filePath, 'utf8');
  const frontmatter = parseFrontmatter(content);
  return {
    name: frontmatter['agent-name'] || frontmatter.name || path.basename(filePath, '.md'),
    status: frontmatter['status'] || 'Unknown',
    model: frontmatter['model'] || '—',
    cadence: frontmatter['cadence'] || '—',
    lastSession: frontmatter['last-session'] || null,
    slackChannel: frontmatter['slack-channel'] || null,
    scope,
    filePath,
  };
}

function findMarkdownFile(dir, name) {
  try {
    const expected = `${name}.md`.toLowerCase();
    const match = fs.readdirSync(dir).find(file => file.toLowerCase() === expected);
    return match ? path.join(dir, match) : null;
  } catch {
    const exactPath = safeMarkdownFile(dir, name, 'markdown filename');
    return fs.existsSync(exactPath) ? exactPath : null;
  }
}

function resolveAgentFilePath(name, scope = null) {
  const safeName = assertSafeSegment(name, 'agent name');
  const safeScope = optionalScope(scope);
  if (safeScope) {
    return findMarkdownFile(projectClaudeAgentDir(safeScope), safeName)
      || findMarkdownFile(projectAgentDir(safeScope), safeName);
  }
  return CLAUDE_AGENT_DIRS.map(dir => findMarkdownFile(dir, safeName)).find(Boolean)
    || findMarkdownFile(AGENTS_DIR, safeName)
    || null;
}

function pushUniqueAgent(agents, agent) {
  const key = `${agent.scope || 'global'}:${agent.name.toLowerCase()}`;
  if (!agents.some(existing => `${existing.scope || 'global'}:${existing.name.toLowerCase()}` === key)) {
    agents.push(agent);
  }
}

function listAgents() {
  const agents = [];

  // Global Claude agents
  for (const dir of CLAUDE_AGENT_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
        try {
          pushUniqueAgent(agents, parseAgentFile(path.join(dir, f), null));
        } catch {}
      }
    } catch {}
  }

  // Legacy global vault agents
  if (fs.existsSync(AGENTS_DIR)) {
    try {
      for (const f of fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'))) {
        try {
          pushUniqueAgent(agents, parseAgentFile(path.join(AGENTS_DIR, f), null));
        } catch {}
      }
    } catch {}
  }

  // Project agents — scan .claude/agents first, then legacy .agents/*.md
  if (fs.existsSync(baseDirectory)) {
    try {
      for (const d of fs.readdirSync(baseDirectory, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue;
        if (!isSafeSegment(d.name)) continue;
        for (const agentsDir of [projectClaudeAgentDir(d.name), projectAgentDir(d.name)]) {
          if (!fs.existsSync(agentsDir)) continue;
          try {
            for (const f of fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'))) {
              try {
                pushUniqueAgent(agents, parseAgentFile(path.join(agentsDir, f), d.name));
              } catch {}
            }
          } catch {}
        }
      }
    } catch {}
  }

  return agents;
}

function countProjectAgents(workspace) {
  const seen = new Set();
  for (const agentsDir of [projectClaudeAgentDir(workspace), projectAgentDir(workspace)]) {
    if (!fs.existsSync(agentsDir)) continue;
    try {
      for (const f of fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'))) {
        try {
          const agent = parseAgentFile(path.join(agentsDir, f), workspace);
          seen.add(agent.name.toLowerCase());
        } catch {}
      }
    } catch {}
  }
  return seen.size;
}

function countGlobalAgents() {
  const seen = new Set();
  for (const agentsDir of [...CLAUDE_AGENT_DIRS, AGENTS_DIR]) {
    if (!fs.existsSync(agentsDir)) continue;
    try {
      for (const f of fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'))) {
        try {
          const agent = parseAgentFile(path.join(agentsDir, f), null);
          seen.add(agent.name.toLowerCase());
        } catch {}
      }
    } catch {}
  }
  return seen.size;
}

function getAgent(name, scope = null) {
  const filePath = resolveAgentFilePath(name, scope);
  if (!filePath) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  return {
    name,
    scope,
    frontmatter: parseFrontmatter(content),
    body: getBody(content),
    filePath,
    raw: content,
  };
}

function writeAgent(name, frontmatter, body, scope = null) {
  const safeScope = optionalScope(scope);
  const filePath = scope
    ? projectAgentFilePath(safeScope, name)
    : safeMarkdownFile(CLAUDE_AGENT_DIRS[0], name, 'agent name');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = stringifyFrontmatter(frontmatter) + '\n\n' + body;
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function updateAgentFrontmatter(name, updates, scope = null) {
  const agent = getAgent(name, scope);
  if (!agent) throw new Error(`Agent not found: ${name}`);
  const merged = { ...agent.frontmatter, ...updates };
  merged['modified'] = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 17) + '000';
  writeAgent(name, merged, agent.body, scope);
}

function deleteAgentFile(name, scope = null) {
  const safeScope = optionalScope(scope);
  const filePath = resolveAgentFilePath(name, safeScope);
  if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

module.exports = {
  listAgents,
  getAgent,
  writeAgent,
  updateAgentFrontmatter,
  deleteAgentFile,
  parseFrontmatter,
  stringifyFrontmatter,
  projectAgentDir,
  projectClaudeAgentDir,
  countProjectAgents,
  countGlobalAgents,
};
