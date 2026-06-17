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

async function runtimeJson(pathname, options = {}) {
  const response = await fetch(`${RUNTIME_API_URL}${pathname}`, {
    ...options,
    headers: {
      ...runtimeHeaders(),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `runtime ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function parseChannelKey(key, value) {
  const [platform, ...rest] = String(key).split(':');
  return {
    key,
    platform,
    channelId: rest.join(':'),
    agent: value?.agent || '',
  };
}

// GET /agents/api/channels — list platform/channel → agent mappings
router.get('/', async (_req, res) => {
  try {
    const channels = await runtimeJson('/api/channels');
    res.json(Object.entries(channels).map(([key, value]) => parseChannelKey(key, value)));
  } catch (err) {
    res.status(err.status || 502).json({ error: `Failed to reach runtime: ${err.message}` });
  }
});

// PUT /agents/api/channels/:platform/:channelId — upsert mapping
router.put('/:platform/:channelId', async (req, res) => {
  try {
    const { agent } = req.body || {};
    if (!agent) return res.status(400).json({ error: 'agent is required' });
    const data = await runtimeJson(
      `/api/channels/${encodeURIComponent(req.params.platform)}/${encodeURIComponent(req.params.channelId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ agent }),
      }
    );
    res.json(data);
  } catch (err) {
    res.status(err.status || 502).json({ error: `Failed to reach runtime: ${err.message}` });
  }
});

// DELETE /agents/api/channels/:platform/:channelId — remove mapping
router.delete('/:platform/:channelId', async (req, res) => {
  try {
    const data = await runtimeJson(
      `/api/channels/${encodeURIComponent(req.params.platform)}/${encodeURIComponent(req.params.channelId)}`,
      { method: 'DELETE' }
    );
    res.json(data);
  } catch (err) {
    res.status(err.status || 502).json({ error: `Failed to reach runtime: ${err.message}` });
  }
});

module.exports = router;
