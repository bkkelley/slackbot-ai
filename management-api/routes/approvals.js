const express = require('express');

const router = express.Router();

const RUNTIME_API_URL = `http://127.0.0.1:${process.env.RUNTIME_HTTP_PORT || '3457'}`;
const BOT_RUNTIME_SHARED_SECRET = process.env.BOT_RUNTIME_SHARED_SECRET || '';

function runtimeHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Bot-Auth': BOT_RUNTIME_SHARED_SECRET,
  };
}

router.get('/', async (req, res) => {
  try {
    const qs = new URLSearchParams();
    if (req.query.status) qs.set('status', req.query.status);
    qs.set('limit', req.query.limit || '50');
    const response = await fetch(`${RUNTIME_API_URL}/api/approvals?${qs}`, {
      headers: runtimeHeaders(),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Failed to reach runtime: ${err.message}` });
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    const response = await fetch(`${RUNTIME_API_URL}/api/approvals/${req.params.id}/approve`, {
      method: 'POST',
      headers: runtimeHeaders(),
      body: JSON.stringify(req.body || {}),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Failed to reach runtime: ${err.message}` });
  }
});

router.post('/:id/deny', async (req, res) => {
  try {
    const response = await fetch(`${RUNTIME_API_URL}/api/approvals/${req.params.id}/deny`, {
      method: 'POST',
      headers: runtimeHeaders(),
      body: JSON.stringify(req.body || {}),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Failed to reach runtime: ${err.message}` });
  }
});

module.exports = router;
