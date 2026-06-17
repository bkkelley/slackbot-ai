const express = require('express');
const fs = require('fs');
const path = require('path');
const { baseDirectory, vaultPath } = require('../../shared/config');

const router = express.Router();

const RUNTIME_API_URL = `http://127.0.0.1:${process.env.RUNTIME_HTTP_PORT || '3457'}`;
const BOT_RUNTIME_SHARED_SECRET = process.env.BOT_RUNTIME_SHARED_SECRET || '';

const KNOWN_LOGS = {
  runtime:           path.join(baseDirectory, 'system/agent-runtime/runtime.log'),
  bot:               path.join(baseDirectory, 'system/slack-bot/bot.log'),
  'inbox-processor': path.join(vaultPath, 'Meta/inbox-processor.log'),
};

function runtimeHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Bot-Auth': BOT_RUNTIME_SHARED_SECRET,
  };
}

async function getRecentJobs(limit = 200) {
  try {
    const response = await fetch(`${RUNTIME_API_URL}/api/jobs?limit=${limit}`, { headers: runtimeHeaders() });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    return [];
  }
}

function parseLogLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function formatJobLine(job) {
  const action = job.action ? ` / ${job.action}` : '';
  const scope = job.scope ? ` (${job.scope})` : '';
  const started = job.startedAt || job.createdAt || '';
  return `[job] ${started} ${job.agent || 'unknown'}${action}${scope} ${job.status} ${job.id}`;
}

function readTailLines(filePath, lineCount, maxBytes = 256 * 1024) {
  if (!fs.existsSync(filePath)) return [];
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf8').split('\n').filter(Boolean).slice(-lineCount);
  } finally {
    fs.closeSync(fd);
  }
}

function matchesAgentLine(line, agentName, jobIds) {
  const parsed = parseLogLine(line);
  if (!parsed) return false;
  if (parsed.agent && parsed.agent.toLowerCase() === agentName.toLowerCase()) return true;
  return parsed.jobId && jobIds.has(parsed.jobId);
}

// GET /agents/api/logs — list available logs
router.get('/', async (req, res) => {
  const systemLogs = Object.entries(KNOWN_LOGS).map(([name, filePath]) => ({
    name,
    label: name,
    type: 'system',
    path: filePath,
    exists: fs.existsSync(filePath),
    size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
  }));

  const jobs = await getRecentJobs();
  const agentCounts = new Map();
  for (const job of jobs) {
    if (!job.agent) continue;
    agentCounts.set(job.agent, (agentCounts.get(job.agent) || 0) + 1);
  }

  const agentLogs = Array.from(agentCounts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agent, jobCount]) => ({
      name: `agent:${agent}`,
      label: agent,
      type: 'agent',
      agent,
      exists: true,
      jobCount,
    }));

  res.json([...systemLogs, ...agentLogs]);
});

// GET /agents/api/logs/stream?log=runtime&lines=100 — SSE tail
// GET /agents/api/logs/stream?agent=AgentName&lines=100 — tail runtime lines for an agent
router.get('/stream', async (req, res) => {
  const logName = req.query.log || 'runtime';
  const agentName = req.query.agent;
  const requestedLines = parseInt(req.query.lines || '100', 10);
  const initialLines = Math.min(Math.max(Number.isFinite(requestedLines) ? requestedLines : 100, 1), 500);
  const filePath = agentName ? KNOWN_LOGS.runtime : KNOWN_LOGS[logName];

  if (!filePath) return res.status(400).json({ error: `Unknown log: ${logName}` });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (line) => res.write(`data: ${JSON.stringify({ line })}\n\n`);

  let agentJobIds = new Set();
  if (agentName) {
    const jobs = await getRecentJobs();
    const agentJobs = jobs.filter((job) => job.agent && job.agent.toLowerCase() === agentName.toLowerCase());
    agentJobIds = new Set(agentJobs.map((job) => job.id));

    send(`[agent] ${agentName} - ${agentJobs.length} recent run${agentJobs.length === 1 ? '' : 's'}`);
    for (const job of agentJobs.slice(0, 25)) {
      send(formatJobLine(job));
      if (job.result?.error) send(`[error] ${job.result.error}`);
    }
  }

  // Read and send last N lines
  let position = 0;
  if (fs.existsSync(filePath)) {
    try {
      const lines = readTailLines(filePath, Math.max(initialLines * 4, initialLines));
      const visibleLines = agentName
        ? lines.filter((line) => matchesAgentLine(line, agentName, agentJobIds))
        : lines;
      const tail = visibleLines.slice(-initialLines);
      for (const line of tail) send(line);
      position = fs.statSync(filePath).size;
    } catch {}
  }

  // Poll for new content
  const interval = setInterval(() => {
    if (!fs.existsSync(filePath)) return;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= position) return;
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(stat.size - position);
      fs.readSync(fd, buf, 0, buf.length, position);
      fs.closeSync(fd);
      position = stat.size;
      const newLines = buf.toString('utf8').split('\n').filter(Boolean);
      for (const line of newLines) {
        if (!agentName) {
          send(line);
          continue;
        }
        const parsed = parseLogLine(line);
        if (parsed?.agent && parsed.agent.toLowerCase() === agentName.toLowerCase() && parsed.jobId) {
          agentJobIds.add(parsed.jobId);
        }
        if (matchesAgentLine(line, agentName, agentJobIds)) send(line);
      }
    } catch {}
  }, 1000);

  req.on('close', () => clearInterval(interval));
});

module.exports = router;
