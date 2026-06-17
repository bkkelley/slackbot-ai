const express = require('express');
const fs = require('fs');
const path = require('path');
const { assertSafeSegment, optionalScope, handleHttpError } = require('../../shared/path-guard');

const router = express.Router();
const evalsPath = path.join(__dirname, '..', 'data', 'agent-evals.json');
const RUNTIME_API_URL = `http://127.0.0.1:${process.env.RUNTIME_HTTP_PORT || '3457'}`;
const BOT_RUNTIME_SHARED_SECRET = process.env.BOT_RUNTIME_SHARED_SECRET || '';

function runtimeHeaders() {
  return { 'Content-Type': 'application/json', 'X-Bot-Auth': BOT_RUNTIME_SHARED_SECRET };
}

function loadEvals() {
  if (!fs.existsSync(evalsPath)) return [];
  const parsed = JSON.parse(fs.readFileSync(evalsPath, 'utf8'));
  return Array.isArray(parsed) ? parsed : [];
}

function saveEvals(evals) {
  fs.mkdirSync(path.dirname(evalsPath), { recursive: true });
  fs.writeFileSync(evalsPath, JSON.stringify(evals, null, 2), 'utf8');
}

function slugFor(name) {
  return String(name || 'eval')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 _.-]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'eval';
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function normalizeEval(input, existing = {}) {
  const name = String(input.name || existing.name || '').trim();
  if (!name) throw new Error('name is required');
  const agent = assertSafeSegment(input.agent || existing.agent, 'agent name');
  const action = assertSafeSegment(input.action || existing.action, 'action name');
  const id = assertSafeSegment(input.id || existing.id || slugFor(`${agent}-${action}-${name}`), 'eval id');
  return {
    ...existing,
    id,
    name,
    agent,
    action,
    scope: optionalScope(input.scope ?? existing.scope) || null,
    toolset: String(input.toolset || existing.toolset || 'vault-readonly').trim(),
    inputText: String(input.inputText ?? existing.inputText ?? ''),
    expectedText: String(input.expectedText ?? existing.expectedText ?? '').trim(),
    forbiddenText: String(input.forbiddenText ?? existing.forbiddenText ?? '').trim(),
    requiredTools: normalizeList(input.requiredTools ?? existing.requiredTools),
    minOutputChars: Number(input.minOutputChars ?? existing.minOutputChars ?? 0) || 0,
    requireCard: Boolean(input.requireCard ?? existing.requireCard),
    requireMessage: Boolean(input.requireMessage ?? existing.requireMessage),
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : existing.enabled !== false,
    updatedAt: new Date().toISOString(),
  };
}

function evaluateResult(evalCase, runtimeResult) {
  const result = runtimeResult.result || runtimeResult;
  const output = String(result.textOutput || '');
  const toolsUsed = result.toolsUsed || [];
  const checks = [];

  checks.push({ label: 'Runtime completed', passed: result.ok === true, detail: result.error || '' });
  if (evalCase.expectedText) {
    checks.push({ label: `Output includes "${evalCase.expectedText}"`, passed: output.includes(evalCase.expectedText), detail: '' });
  }
  if (evalCase.forbiddenText) {
    checks.push({ label: `Output excludes "${evalCase.forbiddenText}"`, passed: !output.includes(evalCase.forbiddenText), detail: '' });
  }
  if (evalCase.minOutputChars > 0) {
    checks.push({ label: `Output has at least ${evalCase.minOutputChars} chars`, passed: output.length >= evalCase.minOutputChars, detail: `${output.length} chars` });
  }
  for (const tool of evalCase.requiredTools || []) {
    checks.push({ label: `Used tool ${tool}`, passed: toolsUsed.includes(tool), detail: toolsUsed.join(', ') || 'no tools' });
  }
  if (evalCase.requireCard) {
    checks.push({ label: 'Wrote a card', passed: (result.cardFiles || []).length > 0, detail: (result.cardFiles || []).join(', ') });
  }
  if (evalCase.requireMessage) {
    checks.push({ label: 'Posted a message', passed: (result.postedMessageIds || []).length > 0, detail: `${(result.postedMessageIds || []).length} messages` });
  }

  const passed = checks.every(check => check.passed);
  return {
    passed,
    status: passed ? 'passed' : 'failed',
    ranAt: new Date().toISOString(),
    jobId: runtimeResult.jobId || null,
    checks,
    outputPreview: output.slice(0, 1200),
    result: {
      ok: result.ok,
      error: result.error || null,
      totalCostUsd: result.totalCostUsd ?? null,
      totalTokens: result.totalTokens ?? null,
      durationMs: result.durationMs ?? null,
      toolsUsed,
      cardFiles: result.cardFiles || [],
      postedMessageIds: result.postedMessageIds || [],
    },
  };
}

async function runEvalCase(evalCase) {
  const response = await fetch(`${RUNTIME_API_URL}/api/jobs`, {
    method: 'POST',
    headers: runtimeHeaders(),
    body: JSON.stringify({
      agent: evalCase.agent,
      action: evalCase.action,
      scope: evalCase.scope || undefined,
      toolset: evalCase.toolset || 'vault-readonly',
      mode: 'sync',
      trigger: 'manual',
      replyText: evalCase.inputText || undefined,
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Runtime ${response.status}`);
  return evaluateResult(evalCase, data);
}

router.get('/', (_req, res) => {
  try {
    res.json({ evals: loadEvals(), path: evalsPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const evals = loadEvals();
    const evalCase = normalizeEval(req.body);
    if (evals.some(item => item.id === evalCase.id)) return res.status(409).json({ error: 'Eval already exists' });
    evals.push({ ...evalCase, createdAt: new Date().toISOString() });
    saveEvals(evals);
    res.status(201).json({ ok: true, eval: evalCase });
  } catch (err) {
    handleHttpError(res, err);
  }
});

router.put('/:id', (req, res) => {
  try {
    const id = assertSafeSegment(req.params.id, 'eval id');
    const evals = loadEvals();
    const index = evals.findIndex(item => item.id === id);
    if (index === -1) return res.status(404).json({ error: 'Eval not found' });
    evals[index] = normalizeEval({ ...req.body, id }, evals[index]);
    saveEvals(evals);
    res.json({ ok: true, eval: evals[index] });
  } catch (err) {
    handleHttpError(res, err);
  }
});

router.delete('/:id', (req, res) => {
  try {
    const id = assertSafeSegment(req.params.id, 'eval id');
    const evals = loadEvals();
    const next = evals.filter(item => item.id !== id);
    if (next.length === evals.length) return res.status(404).json({ error: 'Eval not found' });
    saveEvals(next);
    res.json({ ok: true });
  } catch (err) {
    handleHttpError(res, err);
  }
});

router.post('/:id/run', async (req, res) => {
  try {
    const id = assertSafeSegment(req.params.id, 'eval id');
    const evals = loadEvals();
    const index = evals.findIndex(item => item.id === id);
    if (index === -1) return res.status(404).json({ error: 'Eval not found' });
    const run = await runEvalCase(evals[index]);
    evals[index] = { ...evals[index], lastRun: run };
    saveEvals(evals);
    res.json({ ok: true, run, eval: evals[index] });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/run-enabled', async (_req, res) => {
  try {
    const evals = loadEvals();
    const results = [];
    for (let i = 0; i < evals.length; i++) {
      if (evals[i].enabled === false) continue;
      try {
        const run = await runEvalCase(evals[i]);
        evals[i] = { ...evals[i], lastRun: run };
        results.push({ id: evals[i].id, run });
      } catch (err) {
        const run = {
          passed: false,
          status: 'failed',
          ranAt: new Date().toISOString(),
          jobId: null,
          checks: [{ label: 'Runtime reachable', passed: false, detail: err.message }],
          outputPreview: '',
          result: { ok: false, error: err.message },
        };
        evals[i] = { ...evals[i], lastRun: run };
        results.push({ id: evals[i].id, run });
      }
    }
    saveEvals(evals);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
