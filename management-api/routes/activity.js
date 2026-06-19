const express = require('express');

const router = express.Router();

const RUNTIME_API_URL = `http://127.0.0.1:${process.env.RUNTIME_HTTP_PORT || '3457'}`;
const BOT_RUNTIME_SHARED_SECRET = process.env.BOT_RUNTIME_SHARED_SECRET || '';

function runtimeHeaders() {
  return { 'Content-Type': 'application/json', 'X-Bot-Auth': BOT_RUNTIME_SHARED_SECRET };
}

function summarize(job) {
  const r = job.result || {};
  if (r.ok === false && r.error) return r.error;
  const text = (r.textOutput || '').trim();
  if (!text) return null;
  return text.length > 240 ? text.slice(0, 240) + '…' : text;
}

// GET /agents/api/activity?limit=50
// Recent activity = jobs the runtime has run (replaces the old vault-card feed).
router.get('/', async (req, res) => {
  try {
    const limit = req.query.limit || '50';
    const qs = new URLSearchParams({ limit });
    const r = await fetch(`${RUNTIME_API_URL}/api/jobs?${qs}`, { headers: runtimeHeaders() });
    if (!r.ok) return res.status(r.status).json([]);
    const data = await r.json();
    const jobs = Array.isArray(data) ? data : data.jobs || [];

    const results = jobs.map((job) => ({
      id: job.id,
      agent: job.agent || '',
      action: job.action || '',
      status: job.status,
      ok: job.result ? job.result.ok !== false : job.status !== 'failed',
      date: job.completedAt || job.startedAt || job.createdAt || null,
      mtime: job.completedAt || job.startedAt || job.createdAt || null,
      summary: summarize(job),
      durationMs: job.result?.durationMs ?? null,
      costUsd: job.result?.totalCostUsd ?? null,
      model: job.result?.model ?? null,
    }));

    results.sort((a, b) => new Date(b.mtime || 0) - new Date(a.mtime || 0));
    res.json(results);
  } catch (err) {
    res.status(502).json({ error: `Runtime unreachable: ${err.message}` });
  }
});

module.exports = router;
