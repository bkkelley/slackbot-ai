const express = require('express');
const { schedulerDir } = require('../../shared/config');
const path = require('path');
const fs = require('fs');

const router = express.Router();

const RUNTIME_API_URL = `http://127.0.0.1:${process.env.RUNTIME_HTTP_PORT || '3457'}`;
const BOT_RUNTIME_SHARED_SECRET = process.env.BOT_RUNTIME_SHARED_SECRET || '';

// POST /agents/api/dispatch/run — submit job to runtime API
// Body: { agentName, actionName, files?, noSlack?, replyText?, sessionId? }
router.post('/run', async (req, res) => {
  const { agentName, actionName, files, noSlack, toolset, scope, model, replyText, sessionId, mode } = req.body;
  if (!agentName || !actionName) {
    return res.status(400).json({ error: 'agentName and actionName are required' });
  }

  const jobRequest = {
    agent: agentName,
    action: actionName,
    mode: mode === 'preview' ? 'preview' : 'async',
    trigger: 'manual',
    toolset: toolset || undefined,
    scope: scope || undefined,
    model: model || undefined,
    replyText: replyText || undefined,
    sessionId: sessionId || undefined,
    ...(files ? { files: Array.isArray(files) ? files : [files] } : {}),
  };

  try {
    const response = await fetch(`${RUNTIME_API_URL}/api/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Auth': BOT_RUNTIME_SHARED_SECRET,
      },
      body: JSON.stringify(jobRequest),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: `Runtime API error: ${response.status} ${text}` });
    }

    const result = await response.json();
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `Failed to reach runtime: ${err.message}` });
  }
});

module.exports = router;
