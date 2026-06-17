const fs = require('fs');
const path = require('path');
const os = require('os');
const { vaultPath, baseDirectory } = require('./config');
const { assertSafeSegment, isSafeSegment, optionalScope, safeJoin, safeMarkdownFile } = require('./path-guard');

const GLOBAL_PERSONAS_DIR = path.join(os.homedir(), '.agents', 'personas');
const LEGACY_GLOBAL_PERSONAS_DIR = path.join(vaultPath, '_personas');

function workspacePersonasDir(scope) {
  return safeJoin(baseDirectory, optionalScope(scope), '.agents', 'personas');
}

function canonicalPersonasDir(scope = null) {
  return scope ? workspacePersonasDir(scope) : GLOBAL_PERSONAS_DIR;
}

function readPersonaDir(dir, scope, source) {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(file => file.endsWith('.md'))
      .map(file => ({
        name: file.slice(0, -3),
        scope,
        filePath: path.join(dir, file),
        source,
      }));
  } catch {
    return [];
  }
}

function listPersonasForScope(scope = null) {
  const safeScope = optionalScope(scope);
  const personas = safeScope
    ? readPersonaDir(workspacePersonasDir(safeScope), safeScope, 'workspace')
    : [
        ...readPersonaDir(GLOBAL_PERSONAS_DIR, null, 'global'),
        ...readPersonaDir(LEGACY_GLOBAL_PERSONAS_DIR, null, 'legacy-global'),
      ];
  const seen = new Set();
  return personas.filter(persona => {
    const key = persona.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function listPersonaGroups() {
  const groups = [{ scope: null, label: 'Global', personas: listPersonasForScope(null) }];
  if (!fs.existsSync(baseDirectory)) return groups;
  try {
    for (const d of fs.readdirSync(baseDirectory, { withFileTypes: true })) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      if (d.name.startsWith('.') || !isSafeSegment(d.name)) continue;
      const personas = listPersonasForScope(d.name);
      if (personas.length > 0) groups.push({ scope: d.name, label: d.name, personas });
    }
  } catch {}
  return groups;
}

function resolvePersonaFilePath(name, scope = null) {
  const safeName = assertSafeSegment(name, 'persona name');
  const safeScope = optionalScope(scope);
  const candidates = [];
  if (safeScope) candidates.push(safeMarkdownFile(workspacePersonasDir(safeScope), safeName, 'persona name'));
  candidates.push(
    safeMarkdownFile(GLOBAL_PERSONAS_DIR, safeName, 'persona name'),
    safeMarkdownFile(LEGACY_GLOBAL_PERSONAS_DIR, safeName, 'persona name'),
  );
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function personaFilePathForWrite(name, scope = null) {
  return safeMarkdownFile(canonicalPersonasDir(scope), name, 'persona name');
}

function countWorkspacePersonas(scope) {
  return listPersonasForScope(scope).length;
}

module.exports = {
  GLOBAL_PERSONAS_DIR,
  LEGACY_GLOBAL_PERSONAS_DIR,
  countWorkspacePersonas,
  listPersonaGroups,
  listPersonasForScope,
  personaFilePathForWrite,
  resolvePersonaFilePath,
  workspacePersonasDir,
};
