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

// POST /agents/api/jobs — create/update a scheduled job (upsert via runtime /api/schedules)
router.post('/', async (req, res) => {
  try {
    const response = await fetch(`${RUNTIME_API_URL}/api/schedules`, {
      method: 'POST',
      headers: runtimeHeaders(),
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Failed to reach runtime: ${err.message}` });
  }
});

// PUT /agents/api/jobs/:id — update an existing scheduled job
router.put('/:id', async (req, res) => {
  try {
    const response = await fetch(`${RUNTIME_API_URL}/api/schedules`, {
      method: 'POST',
      headers: runtimeHeaders(),
      body: JSON.stringify({ ...req.body, id: req.params.id }),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Failed to reach runtime: ${err.message}` });
  }
});

// PATCH /agents/api/jobs/:id — partial update of a scheduled job (merges with existing)
router.patch('/:id', async (req, res) => {
  try {
    const listResp = await fetch(`${RUNTIME_API_URL}/api/schedules`, { headers: runtimeHeaders() });
    const { schedules } = await listResp.json();
    const existing = (schedules || []).find(j => j.id === req.params.id) || {};
    const merged = { ...existing, ...req.body, id: req.params.id };
    const response = await fetch(`${RUNTIME_API_URL}/api/schedules`, {
      method: 'POST',
      headers: runtimeHeaders(),
      body: JSON.stringify(merged),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Failed to reach runtime: ${err.message}` });
  }
});

// GET /agents/api/jobs — list schedule templates from runtime /api/schedules
router.get('/', async (req, res) => {
  try {
    const response = await fetch(`${RUNTIME_API_URL}/api/schedules`, { headers: runtimeHeaders() });
    const { schedules } = await response.json();
    res.status(response.status).json(schedules || []);
  } catch (err) {
    res.status(502).json({ error: `Failed to reach runtime: ${err.message}` });
  }
});

// DELETE /agents/api/jobs/:id — delete a schedule template
router.delete('/:id', async (req, res) => {
  try {
    const response = await fetch(`${RUNTIME_API_URL}/api/schedules/${req.params.id}`, {
      method: 'DELETE',
      headers: runtimeHeaders(),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Failed to reach runtime: ${err.message}` });
  }
});

module.exports = router;
