const fs = require('fs');
const path = require('path');
const os = require('os');
const { baseDirectory } = require('./config');
const { assertSafeSegment, optionalScope, safeJoin, safeMarkdownFile } = require('./path-guard');

const GLOBAL_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const GLOBAL_AGENTS_DIR = path.join(os.homedir(), '.claude', 'agents');
const LEGACY_COMMANDS_DIR = path.join(os.homedir(), '.claude', 'commands');

const AGENT_SCOPE_PREFIX = 'agent:';

function agentScopeKey(scope, agent) {
  const safeScope = scope ? optionalScope(scope) : 'global';
  const safeAgent = assertSafeSegment(agent, 'agent name');
  return `${AGENT_SCOPE_PREFIX}${safeScope}:${safeAgent}`;
}

function parseSkillScope(scope) {
  if (scope === 'global') return { type: 'global', scope: null, agent: null };
  if (String(scope || '').startsWith(AGENT_SCOPE_PREFIX)) {
    const [, rawScope, ...agentParts] = String(scope).split(':');
    const agent = agentParts.join(':');
    return {
      type: 'agent',
      scope: rawScope === 'global' ? null : optionalScope(rawScope),
      agent: assertSafeSegment(agent, 'agent name'),
    };
  }
  return { type: 'workspace', scope: optionalScope(scope), agent: null };
}

function skillDirectoryForWrite(scope, skill) {
  const safeSkill = assertSafeSegment(skill, 'skill name');
  const parsed = parseSkillScope(scope);
  if (parsed.type === 'global') return safeJoin(GLOBAL_SKILLS_DIR, safeSkill);
  if (parsed.type === 'agent') {
    return parsed.scope
      ? safeJoin(baseDirectory, parsed.scope, '.claude', 'agents', parsed.agent, 'skills', safeSkill)
      : safeJoin(GLOBAL_AGENTS_DIR, parsed.agent, 'skills', safeSkill);
  }
  return safeJoin(baseDirectory, parsed.scope, '.claude', 'skills', safeSkill);
}

function candidateSkillFiles({ skill, scope = null, agent = null, agentScope = undefined } = {}) {
  const safeSkill = assertSafeSegment(skill, 'skill name');
  const safeScope = optionalScope(scope);
  const files = [];
  if (agent) {
    const safeAgent = assertSafeSegment(agent, 'agent name');
    const safeAgentScope = agentScope === undefined ? safeScope : optionalScope(agentScope);
    if (safeAgentScope) {
      files.push(
        { kind: 'agent', path: safeJoin(baseDirectory, safeAgentScope, '.claude', 'agents', safeAgent, 'skills', safeSkill, 'SKILL.md') },
        { kind: 'agent-legacy', path: safeJoin(baseDirectory, safeAgentScope, '.agents', safeAgent, 'skills', safeSkill, 'SKILL.md') },
      );
    } else {
      files.push({ kind: 'agent', path: safeJoin(GLOBAL_AGENTS_DIR, safeAgent, 'skills', safeSkill, 'SKILL.md') });
    }
  }
  if (safeScope) {
    files.push(
      { kind: 'workspace', path: safeJoin(baseDirectory, safeScope, '.claude', 'skills', safeSkill, 'SKILL.md') },
      { kind: 'workspace-legacy', path: safeJoin(baseDirectory, safeScope, '.agents', 'skills', safeSkill, 'SKILL.md') },
    );
  }
  files.push(
    { kind: 'global', path: safeJoin(GLOBAL_SKILLS_DIR, safeSkill, 'SKILL.md') },
    { kind: 'legacy-command', path: safeMarkdownFile(LEGACY_COMMANDS_DIR, safeSkill, 'skill name') },
  );
  return files;
}

function findSkillFile(input) {
  return candidateSkillFiles(input).find(candidate => fs.existsSync(candidate.path)) || null;
}

function skillSearchSummary(input) {
  return candidateSkillFiles(input).map(candidate => candidate.path).join(', ');
}

module.exports = {
  AGENT_SCOPE_PREFIX,
  GLOBAL_AGENTS_DIR,
  GLOBAL_SKILLS_DIR,
  LEGACY_COMMANDS_DIR,
  agentScopeKey,
  parseSkillScope,
  skillDirectoryForWrite,
  candidateSkillFiles,
  findSkillFile,
  skillSearchSummary,
};
