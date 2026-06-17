const express = require('express');
const WebSocket = require('ws');

const router = express.Router();

const RUNTIME_API_URL = `http://127.0.0.1:${process.env.RUNTIME_HTTP_PORT || '3457'}`;
const RUNTIME_WS_URL = `ws://127.0.0.1:${process.env.RUNTIME_HTTP_PORT || '3457'}`;
const BOT_RUNTIME_SHARED_SECRET = process.env.BOT_RUNTIME_SHARED_SECRET || '';

function runtimeHeaders() {
  return { 'Content-Type': 'application/json', 'X-Bot-Auth': BOT_RUNTIME_SHARED_SECRET };
}

// GET /agents/api/queue/stats — agent cost/usage rollup
router.get('/stats', async (req, res) => {
  try {
    const qs = new URLSearchParams();
    if (req.query.window) qs.set('window', req.query.window);
    const r = await fetch(`${RUNTIME_API_URL}/api/jobs/stats?${qs}`, { headers: runtimeHeaders() });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Runtime unreachable: ${err.message}` });
  }
});

// GET /agents/api/queue — list recent jobs from SQLite
router.get('/', async (req, res) => {
  try {
    const qs = new URLSearchParams();
    if (req.query.status) qs.set('status', req.query.status);
    if (req.query.parentJobId) qs.set('parentJobId', req.query.parentJobId);
    qs.set('limit', req.query.limit || '40');
    const url = `${RUNTIME_API_URL}/api/jobs?${qs}`;
    const r = await fetch(url, { headers: runtimeHeaders() });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Runtime unreachable: ${err.message}` });
  }
});

// GET /agents/api/queue/:id/debug — prompt/session diagnostics
router.get('/:id/debug', async (req, res) => {
  try {
    const r = await fetch(`${RUNTIME_API_URL}/api/jobs/${req.params.id}/debug`, { headers: runtimeHeaders() });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Runtime unreachable: ${err.message}` });
  }
});

// GET /agents/api/queue/:id — single job
router.get('/:id', async (req, res) => {
  try {
    const r = await fetch(`${RUNTIME_API_URL}/api/jobs/${req.params.id}`, { headers: runtimeHeaders() });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Runtime unreachable: ${err.message}` });
  }
});

// DELETE /agents/api/queue/:id — cancel a queued job
router.delete('/:id', async (req, res) => {
  try {
    const r = await fetch(`${RUNTIME_API_URL}/api/jobs/${req.params.id}`, {
      method: 'DELETE',
      headers: runtimeHeaders(),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Runtime unreachable: ${err.message}` });
  }
});

// GET /agents/api/queue/:id/stream — SSE proxy for runtime WebSocket stream
router.get('/:id/stream', async (req, res) => {
  const jobId = req.params.id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Check current job status first
  let job;
  try {
    const r = await fetch(`${RUNTIME_API_URL}/api/jobs/${jobId}`, { headers: runtimeHeaders() });
    if (!r.ok) {
      send({ type: 'error', message: `Job not found: ${jobId}` });
      send({ type: 'done' });
      res.end();
      return;
    }
    job = await r.json();
  } catch (err) {
    send({ type: 'error', message: `Runtime unreachable: ${err.message}` });
    send({ type: 'done' });
    res.end();
    return;
  }

  // Already finished — send terminal state immediately
  if (job.status === 'done' || job.status === 'failed') {
    send({ type: 'status', status: job.status, result: job.result ?? null });
    send({ type: 'done' });
    res.end();
    return;
  }

  // Connect to runtime WebSocket
  const ws = new WebSocket(`${RUNTIME_WS_URL}/api/jobs/${jobId}/stream`, {
    headers: { 'X-Bot-Auth': BOT_RUNTIME_SHARED_SECRET },
  });

  ws.on('open', () => {
    send({ type: 'status', status: 'running' });
  });

  ws.on('message', (data) => {
    try {
      const event = JSON.parse(data.toString());
      send(event);
      if (event.type === 'done' || (event.type === 'status' && (event.status === 'done' || event.status === 'failed'))) {
        ws.close();
        if (!res.writableEnded) res.end();
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.on('error', (err) => {
    send({ type: 'error', message: `Stream error: ${err.message}` });
    send({ type: 'done' });
    if (!res.writableEnded) res.end();
  });

  ws.on('close', () => {
    if (!res.writableEnded) res.end();
  });

  req.on('close', () => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  });
});

module.exports = router;
