const path = require('path');

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,120}$/;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function assertSafeSegment(value, label = 'name') {
  const text = String(value || '').trim();
  if (!text || text === '.' || text === '..' || text.includes('/') || text.includes('\\') || !SEGMENT_RE.test(text)) {
    throw httpError(400, `${label} contains unsupported characters`);
  }
  return text;
}

function isSafeSegment(value) {
  try {
    assertSafeSegment(value);
    return true;
  } catch {
    return false;
  }
}

function optionalScope(value) {
  if (!value) return null;
  return assertSafeSegment(value, 'scope');
}

function assertInside(rootPath, targetPath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw httpError(403, 'Path escapes allowed root');
  }
  return target;
}

function safeJoin(rootPath, ...parts) {
  return assertInside(rootPath, path.join(rootPath, ...parts));
}

function safeMarkdownFile(dir, name, label = 'name') {
  return safeJoin(dir, `${assertSafeSegment(name, label)}.md`);
}

function handleHttpError(res, err) {
  res.status(err.status || 500).json({ error: err.message });
}

module.exports = {
  assertSafeSegment,
  isSafeSegment,
  optionalScope,
  safeJoin,
  safeMarkdownFile,
  handleHttpError,
};
