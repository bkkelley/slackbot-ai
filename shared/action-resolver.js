const fs = require('fs');
const path = require('path');
const os = require('os');
const { vaultPath, baseDirectory } = require('./config');
const { assertSafeSegment, isSafeSegment, optionalScope, safeJoin, safeMarkdownFile } = require('./path-guard');
const { parseFrontmatter } = require('./vault');

const GLOBAL_ACTIONS_DIR = path.join(os.homedir(), '.agents', 'actions');
const LEGACY_GLOBAL_ACTIONS_DIR = path.join(vaultPath, '_agent_actions');

function workspaceActionsDir(scope) {
  return safeJoin(baseDirectory, optionalScope(scope), '.agents', 'actions');
}

function canonicalActionsDir(scope = null) {
  return scope ? workspaceActionsDir(scope) : GLOBAL_ACTIONS_DIR;
}

function legacyActionName(agentName, actionName) {
  return `${assertSafeSegment(agentName, 'agent name')} - ${assertSafeSegment(actionName, 'action name')}`;
}

function parseListValue(value) {
  if (!value) return [];
  const text = String(value).trim();
  if (!text) return [];
  if (text.startsWith('[') && text.endsWith(']')) {
    return text.slice(1, -1).split(',').map(item => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return text.split(',').map(item => item.trim()).filter(Boolean);
}

function parseAgentsFromFrontmatter(content) {
  const fm = parseFrontmatter(content);
  const inline = fm.agents || fm.agent || fm.appliesTo || fm['applies-to'];
  if (inline) return parseListValue(inline);

  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];
  const lines = match[1].split('\n');
  const agents = [];
  let inAgents = false;
  for (const line of lines) {
    if (/^\s*(agents|appliesTo|applies-to):\s*$/.test(line)) {
      inAgents = true;
      continue;
    }
    if (inAgents) {
      const item = line.match(/^\s*-\s+(.+?)\s*$/);
      if (item) {
        agents.push(item[1].replace(/^["']|["']$/g, ''));
        continue;
      }
      if (/^\S/.test(line)) break;
    }
  }
  return agents.filter(Boolean);
}

function actionAllowsAgent(action, agentName) {
  if (!action.agents || action.agents.length === 0) return true;
  return action.agents.some(agent => agent.toLowerCase() === agentName.toLowerCase());
}

function parseActionFile(dir, filename, scope, source) {
  if (!filename.endsWith('.md')) return null;
  const filePath = path.join(dir, filename);
  const basename = filename.slice(0, -3);
  const legacyMatch = basename.match(/^(.+?)\s+-\s+(.+)$/);
  if (legacyMatch) {
    return {
      name: legacyMatch[2],
      agents: [legacyMatch[1]],
      scope,
      filePath,
      source,
      legacy: true,
    };
  }

  let agents = [];
  try {
    agents = parseAgentsFromFrontmatter(fs.readFileSync(filePath, 'utf8'));
  } catch {}
  return {
    name: basename,
    agents,
    scope,
    filePath,
    source,
    legacy: false,
  };
}

function findAction(agentName, actionName, scope = null) {
  const filePath = resolveActionFilePath(agentName, actionName, scope);
  if (!filePath) return null;
  const action = parseActionFile(path.dirname(filePath), path.basename(filePath), optionalScope(scope), 'resolved');
  return action ? { ...action, filePath } : null;
}

function readActionDir(dir, scope, source) {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(file => file.endsWith('.md'))
      .map(file => parseActionFile(dir, file, scope, source))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listActionsForScope(scope = null) {
  const safeScope = optionalScope(scope);
  const actions = [];
  if (safeScope) {
    actions.push(...readActionDir(workspaceActionsDir(safeScope), safeScope, 'workspace'));
  } else {
    actions.push(...readActionDir(GLOBAL_ACTIONS_DIR, null, 'global'));
    actions.push(...readActionDir(LEGACY_GLOBAL_ACTIONS_DIR, null, 'legacy-global'));
  }

  const seen = new Set();
  return actions.sort((a, b) => {
    if (a.legacy !== b.legacy) return a.legacy ? 1 : -1;
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.name.localeCompare(b.name);
  }).filter(action => {
    const agentsKey = action.agents.length > 0 ? action.agents.map(a => a.toLowerCase()).sort().join(',') : '*';
    const key = `${action.name.toLowerCase()}:${agentsKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function listActionsForAgent(agentName, scope = null) {
  const safeAgent = assertSafeSegment(agentName, 'agent name');
  const safeScope = optionalScope(scope);
  const candidates = [
    ...(safeScope ? listActionsForScope(safeScope) : []),
    ...listActionsForScope(null),
  ];
  const seen = new Set();
  return candidates
    .filter(action => actionAllowsAgent(action, safeAgent))
    .filter(action => {
      const key = action.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(action => ({ ...action, agents: action.agents.length > 0 ? action.agents : [safeAgent] }));
}

function resolveActionFilePath(agentName, actionName, scope = null) {
  const safeAgent = assertSafeSegment(agentName, 'agent name');
  const safeAction = assertSafeSegment(actionName, 'action name');
  const safeScope = optionalScope(scope);
  const legacyName = legacyActionName(safeAgent, safeAction);
  const candidates = [];
  if (safeScope) {
    candidates.push(
      safeMarkdownFile(workspaceActionsDir(safeScope), safeAction, 'action name'),
      safeMarkdownFile(workspaceActionsDir(safeScope), legacyName, 'action filename'),
    );
  }
  candidates.push(
    safeMarkdownFile(GLOBAL_ACTIONS_DIR, safeAction, 'action name'),
    safeMarkdownFile(GLOBAL_ACTIONS_DIR, legacyName, 'action filename'),
    safeMarkdownFile(LEGACY_GLOBAL_ACTIONS_DIR, legacyName, 'action filename'),
  );

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const action = parseActionFile(path.dirname(candidate), path.basename(candidate), safeScope, 'resolved');
    if (!action || actionAllowsAgent(action, safeAgent)) return candidate;
  }
  return null;
}

function actionFilePathForWrite(actionName, scope = null) {
  return safeMarkdownFile(canonicalActionsDir(scope), actionName, 'action name');
}

function groupActions(actions) {
  const agentMap = {};
  for (const action of actions) {
    const agents = action.agents.length > 0 ? action.agents : ['Shared'];
    for (const agent of agents) {
      if (!agentMap[agent]) agentMap[agent] = [];
      if (!agentMap[agent].some(existing => existing.name.toLowerCase() === action.name.toLowerCase())) {
        agentMap[agent].push({ name: action.name, path: action.filePath, legacy: action.legacy });
      }
    }
  }
  return Object.keys(agentMap).sort().map(agent => ({
    name: agent,
    actions: agentMap[agent].sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

function listActionGroups() {
  const groups = [{ scope: null, label: 'Global', agents: groupActions(listActionsForScope(null)) }];
  if (!fs.existsSync(baseDirectory)) return groups;
  try {
    for (const d of fs.readdirSync(baseDirectory, { withFileTypes: true })) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      if (d.name.startsWith('.') || !isSafeSegment(d.name)) continue;
      const actions = listActionsForScope(d.name);
      if (actions.length > 0) groups.push({ scope: d.name, label: d.name, agents: groupActions(actions) });
    }
  } catch {}
  return groups;
}

function countWorkspaceActions(scope) {
  return listActionsForScope(scope).length;
}

function formatActionTemplate(agentNames, actionName) {
  const safeAgents = (Array.isArray(agentNames) ? agentNames : [agentNames])
    .map(agent => assertSafeSegment(agent, 'agent name'));
  const safeAction = assertSafeSegment(actionName, 'action name');
  const agentLines = safeAgents.map(agent => `  - ${agent}`).join('\n');
  const agentText = safeAgents.length === 1 ? safeAgents[0] : safeAgents.join(', ');
  return `---\nagents:\n${agentLines}\n---\n\n# Action: ${safeAction}\n\nYou are ${agentText}.\n\n## Output\n\nCall the \`PostMessage\` tool with your message text.\n`;
}

module.exports = {
  GLOBAL_ACTIONS_DIR,
  LEGACY_GLOBAL_ACTIONS_DIR,
  actionFilePathForWrite,
  countWorkspaceActions,
  formatActionTemplate,
  findAction,
  listActionGroups,
  listActionsForAgent,
  listActionsForScope,
  resolveActionFilePath,
  workspaceActionsDir,
};
