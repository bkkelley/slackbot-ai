const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { baseDirectory, vaultPath } = require('../../shared/config');

const router = express.Router();

const ROOTS = {
  workspaces: { label: 'Workspaces', path: baseDirectory },
  vault: { label: 'Vault', path: vaultPath },
  system: { label: 'System', path: path.resolve(__dirname, '../..') },
  home: { label: 'Home', path: os.homedir() },
};

const TEXT_EXTENSIONS = new Set([
  '.cjs', '.conf', '.css', '.csv', '.env', '.html', '.ini', '.js', '.json', '.jsx',
  '.log', '.md', '.mjs', '.sh', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
]);

const IMAGE_EXTENSIONS = new Set(['.gif', '.jpg', '.jpeg', '.png', '.svg', '.webp']);

function rootList() {
  return Object.entries(ROOTS).map(([id, root]) => ({
    id,
    label: root.label,
    exists: fs.existsSync(root.path),
  }));
}

function resolveRoot(rootId) {
  const root = ROOTS[rootId];
  if (!root) return null;
  return { ...root, id: rootId, path: path.resolve(root.path) };
}

function resolveSafePath(rootId, requestedPath = '') {
  const root = resolveRoot(rootId);
  if (!root) {
    const err = new Error('Unknown root');
    err.status = 400;
    throw err;
  }

  const relativePath = String(requestedPath || '').replace(/^\/+/, '');
  const fullPath = path.resolve(root.path, relativePath);
  if (fullPath !== root.path && !fullPath.startsWith(root.path + path.sep)) {
    const err = new Error('Path escapes selected root');
    err.status = 403;
    throw err;
  }
  return { root, fullPath, relativePath: path.relative(root.path, fullPath) };
}

function fileKind(filePath, stat) {
  if (stat.isDirectory()) return 'folder';
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'file';
}

function statEntry(dirPath, name) {
  const filePath = path.join(dirPath, name);
  const stat = fs.statSync(filePath);
  return {
    name,
    path: name,
    kind: fileKind(filePath, stat),
    isDirectory: stat.isDirectory(),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    extension: stat.isDirectory() ? '' : path.extname(name).slice(1).toLowerCase(),
  };
}

function handleError(res, err) {
  res.status(err.status || 500).json({ error: err.message });
}

router.get('/roots', (_req, res) => {
  res.json(rootList());
});

router.get('/', (req, res) => {
  try {
    const rootId = req.query.root || 'workspaces';
    const requestedPath = req.query.path || '';
    const { root, fullPath, relativePath } = resolveSafePath(rootId, requestedPath);

    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Path not found' });
    const stat = fs.statSync(fullPath);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Path is not a folder' });

    const entries = fs.readdirSync(fullPath)
      .filter((name) => name !== '.DS_Store')
      .map((name) => {
        try {
          const entry = statEntry(fullPath, name);
          entry.path = path.join(relativePath, name);
          return entry;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    const parentPath = relativePath ? path.dirname(relativePath) : null;

    res.json({
      root: { id: root.id, label: root.label },
      path: relativePath,
      absolutePath: fullPath,
      parentPath: parentPath === '.' ? '' : parentPath,
      entries,
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/content', (req, res) => {
  try {
    const rootId = req.query.root || 'workspaces';
    const requestedPath = req.query.path || '';
    const { fullPath, relativePath } = resolveSafePath(rootId, requestedPath);

    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Path is a folder' });
    if (stat.size > 1024 * 1024) return res.status(413).json({ error: 'File is larger than 1 MB' });

    const kind = fileKind(fullPath, stat);
    if (kind !== 'text') {
      return res.json({
        path: relativePath,
        kind,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }

    res.json({
      path: relativePath,
      kind,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      content: fs.readFileSync(fullPath, 'utf8'),
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.put('/content', (req, res) => {
  try {
    const rootId = req.query.root || req.body.root || 'workspaces';
    const requestedPath = req.query.path || req.body.path || '';
    const { fullPath, relativePath } = resolveSafePath(rootId, requestedPath);
    const { content } = req.body;

    if (content === undefined) return res.status(400).json({ error: 'content is required' });
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Path is a folder' });
    if (fileKind(fullPath, stat) !== 'text') return res.status(415).json({ error: 'Only text files can be edited' });

    fs.writeFileSync(fullPath, content, 'utf8');
    const updated = fs.statSync(fullPath);
    res.json({
      ok: true,
      path: relativePath,
      size: updated.size,
      modifiedAt: updated.mtime.toISOString(),
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/', (req, res) => {
  try {
    const rootId = req.body.root || 'workspaces';
    const parentPath = req.body.parentPath || '';
    const name = String(req.body.name || '').trim();
    const type = req.body.type === 'folder' ? 'folder' : 'file';
    if (!name || name.includes('/') || name.includes('\\')) return res.status(400).json({ error: 'Valid name is required' });
    const { fullPath: parentFullPath, root } = resolveSafePath(rootId, parentPath);
    if (!fs.existsSync(parentFullPath) || !fs.statSync(parentFullPath).isDirectory()) return res.status(400).json({ error: 'Parent folder not found' });
    const fullPath = path.resolve(parentFullPath, name);
    if (fullPath !== root.path && !fullPath.startsWith(root.path + path.sep)) return res.status(403).json({ error: 'Path escapes selected root' });
    if (fs.existsSync(fullPath)) return res.status(409).json({ error: 'File already exists' });
    if (type === 'folder') fs.mkdirSync(fullPath, { recursive: false });
    else fs.writeFileSync(fullPath, req.body.content || '', 'utf8');
    res.status(201).json({ ok: true, path: path.relative(root.path, fullPath) });
  } catch (err) {
    handleError(res, err);
  }
});

router.patch('/', (req, res) => {
  try {
    const rootId = req.body.root || 'workspaces';
    const requestedPath = req.body.path || '';
    const newName = String(req.body.newName || '').trim();
    if (!newName || newName.includes('/') || newName.includes('\\')) return res.status(400).json({ error: 'Valid new name is required' });
    const { fullPath, root } = resolveSafePath(rootId, requestedPath);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Path not found' });
    const nextPath = path.resolve(path.dirname(fullPath), newName);
    if (nextPath !== root.path && !nextPath.startsWith(root.path + path.sep)) return res.status(403).json({ error: 'Path escapes selected root' });
    if (fs.existsSync(nextPath)) return res.status(409).json({ error: 'Destination already exists' });
    fs.renameSync(fullPath, nextPath);
    res.json({ ok: true, path: path.relative(root.path, nextPath) });
  } catch (err) {
    handleError(res, err);
  }
});

router.delete('/', (req, res) => {
  try {
    const rootId = req.body.root || 'workspaces';
    const requestedPath = req.body.path || '';
    const { fullPath } = resolveSafePath(rootId, requestedPath);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Path not found' });
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) fs.rmSync(fullPath, { recursive: true, force: false });
    else fs.unlinkSync(fullPath);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/search', (req, res) => {
  try {
    const rootId = req.query.root || 'workspaces';
    const query = String(req.query.q || '').trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit || '80', 10), 200);
    const { fullPath: startPath, root } = resolveSafePath(rootId, req.query.path || '');
    if (!query) return res.json({ results: [] });
    if (!fs.existsSync(startPath)) return res.status(404).json({ error: 'Path not found' });

    const results = [];
    const stack = [startPath];
    while (stack.length && results.length < limit) {
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.name === '.DS_Store' || entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        const relative = path.relative(root.path, full);
        if (entry.name.toLowerCase().includes(query)) {
          try {
            const stat = fs.statSync(full);
            results.push({
              name: entry.name,
              path: relative,
              kind: fileKind(full, stat),
              isDirectory: stat.isDirectory(),
              size: stat.size,
              modifiedAt: stat.mtime.toISOString(),
              extension: stat.isDirectory() ? '' : path.extname(entry.name).slice(1).toLowerCase(),
            });
          } catch {}
          if (results.length >= limit) break;
        }
        if (entry.isDirectory()) stack.push(full);
      }
    }
    res.json({ results });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/raw', (req, res) => {
  try {
    const rootId = req.query.root || 'workspaces';
    const requestedPath = req.query.path || '';
    const { fullPath } = resolveSafePath(rootId, requestedPath);

    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Path is a folder' });
    if (fileKind(fullPath, stat) !== 'image') return res.status(415).json({ error: 'Raw preview is only available for images' });

    res.sendFile(fullPath);
  } catch (err) {
    handleError(res, err);
  }
});

module.exports = router;
