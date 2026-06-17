const express = require('express');
const fs = require('fs');
const path = require('path');
const { baseDirectory } = require('../../shared/config');
const { assertSafeSegment, isSafeSegment, optionalScope, safeJoin, handleHttpError } = require('../../shared/path-guard');
const {
  GLOBAL_AGENTS_DIR,
  GLOBAL_SKILLS_DIR,
  agentScopeKey,
  parseSkillScope,
  skillDirectoryForWrite,
  findSkillFile,
} = require('../../shared/skill-resolver');

const router = express.Router();

const globalSkillsDir = GLOBAL_SKILLS_DIR;

function readSkillsFromDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => (d.isDirectory() || d.isSymbolicLink()) && fs.existsSync(path.join(dir, d.name, 'SKILL.md')))
    .map(d => {
      const skillDir = fs.realpathSync(path.join(dir, d.name));
      const files = listSkillFiles(skillDir);
      return {
        name: d.name,
        fileCount: files.length,
        supportingFileCount: Math.max(0, files.length - 1),
      };
    });
}

function resolveSkillFile(scope, name) {
  const skillName = assertSafeSegment(name, 'skill name');
  const parsed = parseSkillScope(scope);
  if (parsed.type === 'workspace') {
    const existing = findSkillFile({ skill: skillName, scope: parsed.scope });
    if (existing && (existing.kind === 'workspace' || existing.kind === 'workspace-legacy')) return existing.path;
  } else if (parsed.type === 'agent') {
    const existing = findSkillFile({ skill: skillName, scope: parsed.scope, agent: parsed.agent });
    if (existing && (existing.kind === 'agent' || existing.kind === 'agent-legacy')) return existing.path;
  } else if (parsed.type === 'global') {
    const existing = findSkillFile({ skill: skillName });
    if (existing && existing.kind === 'global') return existing.path;
  }
  return safeJoin(skillDirectoryForWrite(scope, skillName), 'SKILL.md');
}

function resolveSkillDir(scope, name) {
  const dir = path.dirname(resolveSkillFile(scope, name));
  return fs.existsSync(dir) ? fs.realpathSync(dir) : dir;
}

function listSkillFiles(dir, baseDir = dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSkillFiles(fullPath, baseDir, files);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      const relPath = path.relative(baseDir, fullPath).split(path.sep).join('/');
      files.push({
        path: relPath,
        size: fs.statSync(fullPath).size,
        isPrimary: relPath === 'SKILL.md',
      });
    }
  }
  return files.sort((a, b) => {
    if (a.path === 'SKILL.md') return -1;
    if (b.path === 'SKILL.md') return 1;
    return a.path.localeCompare(b.path);
  });
}

function resolveSkillRelativeFile(scope, name, relPath) {
  const skillDir = resolveSkillDir(scope, name);
  const normalized = String(relPath || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid skill file path');
  }
  const filePath = path.resolve(skillDir, normalized);
  const root = path.resolve(skillDir);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    throw new Error('Invalid skill file path');
  }
  return filePath;
}

// GET / — list all skills grouped by scope
// Returns [{ scope: 'global'|'<workspace>', skills: [{name}] }]
router.get('/', (req, res) => {
  try {
    const groups = [];

    // Global skills
    const globalSkills = readSkillsFromDir(globalSkillsDir);
    if (globalSkills.length > 0) {
      groups.push({ scope: 'global', label: 'Global', skills: globalSkills });
    }

    // Agent-specific global skills
    if (fs.existsSync(GLOBAL_AGENTS_DIR)) {
      const agents = fs.readdirSync(GLOBAL_AGENTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && isSafeSegment(d.name));
      for (const agent of agents) {
        const agentSkillsDir = path.join(GLOBAL_AGENTS_DIR, agent.name, 'skills');
        const skills = readSkillsFromDir(agentSkillsDir);
        if (skills.length > 0) {
          groups.push({
            scope: agentScopeKey(null, agent.name),
            label: `Global / ${agent.name}`,
            kind: 'agent',
            agent: agent.name,
            skills,
          });
        }
      }
    }

    // Project-level skills — prefer .claude/skills, merge legacy .agents/skills.
    if (fs.existsSync(baseDirectory)) {
      const workspaces = fs.readdirSync(baseDirectory, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && isSafeSegment(d.name));
      for (const ws of workspaces) {
        const workspaceSkillsDir = path.join(baseDirectory, ws.name, '.claude', 'skills');
        const legacySkillsDir = path.join(baseDirectory, ws.name, '.agents', 'skills');
        const byName = new Map();
        for (const skill of readSkillsFromDir(workspaceSkillsDir)) byName.set(skill.name, skill);
        for (const skill of readSkillsFromDir(legacySkillsDir)) {
          if (!byName.has(skill.name)) byName.set(skill.name, { ...skill, legacy: true });
        }
        const wsSkills = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
        if (wsSkills.length > 0) {
          groups.push({ scope: ws.name, label: ws.name, kind: 'workspace', skills: wsSkills });
        }

        const agentNames = new Set();
        for (const agentsDir of [
          path.join(baseDirectory, ws.name, '.claude', 'agents'),
          path.join(baseDirectory, ws.name, '.agents'),
        ]) {
          if (!fs.existsSync(agentsDir)) continue;
          for (const agent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
            if ((agent.isDirectory() || agent.isSymbolicLink() || agent.isFile()) && isSafeSegment(path.basename(agent.name, '.md'))) {
              agentNames.add(path.basename(agent.name, '.md'));
            }
          }
        }
        for (const agentName of Array.from(agentNames).sort((a, b) => a.localeCompare(b))) {
          const byName = new Map();
          for (const agentSkillsDir of [
            path.join(baseDirectory, ws.name, '.claude', 'agents', agentName, 'skills'),
            path.join(baseDirectory, ws.name, '.agents', agentName, 'skills'),
          ]) {
            for (const skill of readSkillsFromDir(agentSkillsDir)) {
              if (!byName.has(skill.name)) byName.set(skill.name, skill);
            }
          }
          const skills = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
          if (skills.length > 0) {
            groups.push({
              scope: agentScopeKey(ws.name, agentName),
              label: `${ws.name} / ${agentName}`,
              kind: 'agent',
              workspace: ws.name,
              agent: agentName,
              skills,
            });
          }
        }
      }
    }

    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:scope/:name — get skill content
router.get('/:scope/:name', (req, res) => {
  try {
    const scope = parseSkillScope(req.params.scope).type === 'global' ? 'global' : req.params.scope;
    const filePath = resolveSkillFile(scope, req.params.name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Skill not found' });
    res.json({
      content: fs.readFileSync(filePath, 'utf8'),
      path: filePath,
      files: listSkillFiles(path.dirname(filePath)),
    });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// GET /:scope/:name/files — list supporting files
router.get('/:scope/:name/files', (req, res) => {
  try {
    const scope = parseSkillScope(req.params.scope).type === 'global' ? 'global' : req.params.scope;
    const skillDir = resolveSkillDir(scope, req.params.name);
    if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) return res.status(404).json({ error: 'Skill not found' });
    res.json({ files: listSkillFiles(skillDir) });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// GET /:scope/:name/files/* — read a skill file
router.get('/:scope/:name/files/*', (req, res) => {
  try {
    const scope = parseSkillScope(req.params.scope).type === 'global' ? 'global' : req.params.scope;
    const filePath = resolveSkillRelativeFile(scope, req.params.name, req.params[0]);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Skill file not found' });
    res.json({ content: fs.readFileSync(filePath, 'utf8'), path: filePath, relPath: req.params[0] });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// PUT /:scope/:name — save skill content
router.put('/:scope/:name', (req, res) => {
  try {
    const { content } = req.body;
    if (content === undefined) return res.status(400).json({ error: 'content is required' });
    const scope = parseSkillScope(req.params.scope).type === 'global' ? 'global' : req.params.scope;
    const filePath = resolveSkillFile(scope, req.params.name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// PUT /:scope/:name/files/* — save a skill file
router.put('/:scope/:name/files/*', (req, res) => {
  try {
    const { content } = req.body;
    if (content === undefined) return res.status(400).json({ error: 'content is required' });
    const scope = parseSkillScope(req.params.scope).type === 'global' ? 'global' : req.params.scope;
    const skillDir = resolveSkillDir(scope, req.params.name);
    if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) return res.status(404).json({ error: 'Skill not found' });
    const filePath = resolveSkillRelativeFile(scope, req.params.name, req.params[0]);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// POST / — create new skill (body: { name, scope? })
router.post('/', (req, res) => {
  try {
    const { scope = 'global' } = req.body;
    const name = assertSafeSegment(req.body.name, 'skill name');
    const safeScope = parseSkillScope(scope).type === 'global' ? 'global' : scope;
    const filePath = resolveSkillFile(safeScope, name);
    if (fs.existsSync(filePath)) return res.status(409).json({ error: 'Skill already exists' });
    const template = `# ${name}\n\n## Instructions\n\nDescribe what this skill does and how to use it.\n`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, template, 'utf8');
    res.status(201).json({ ok: true, name, scope: safeScope });
  } catch (err) {
    handleHttpError(res, err);
  }
});

// DELETE /:scope/:name — delete skill directory
router.delete('/:scope/:name', (req, res) => {
  try {
    const scope = parseSkillScope(req.params.scope).type === 'global' ? 'global' : req.params.scope;
    const filePath = resolveSkillFile(scope, req.params.name);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Skill not found' });
    fs.rmSync(dir, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    handleHttpError(res, err);
  }
});

module.exports = router;
