const path = require('path');
const crypto = require('crypto');
// Load local .env first, then fall back to system/.env for Slack tokens etc.
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const express = require('express');
const agentsRouter = require('./routes/agents');
const jobsRouter = require('./routes/jobs');
const queueRouter = require('./routes/queue');
const activityRouter = require('./routes/activity');
const dispatchRouter = require('./routes/dispatch');
const logsRouter = require('./routes/logs');
const inboxRouter = require('./routes/inbox');
const actionsRouter = require('./routes/actions');
const workflowsRouter = require('./routes/workflows');
const skillsRouter = require('./routes/skills');
const personasRouter = require('./routes/personas');
const toolsetsRouter = require('./routes/toolsets');
const projectsRouter = require('./routes/projects');
const availableToolsRouter = require('./routes/available-tools');
const filesRouter = require('./routes/files');
const healthRouter = require('./routes/health');
const approvalsRouter = require('./routes/approvals');
const channelsRouter = require('./routes/channels');
const budgetsRouter = require('./routes/budgets');
const notificationsRouter = require('./routes/notifications');
const evalsRouter = require('./routes/evals');
const onboardingRouter = require('./routes/onboarding');

const app = express();
const PORT = process.env.MANAGEMENT_PORT || 3456;
const MANAGEMENT_API_TOKEN = process.env.MANAGEMENT_API_TOKEN || '';

function cookieValue(cookieHeader, name) {
  const cookies = String(cookieHeader || '').split(';');
  for (const cookie of cookies) {
    const [rawKey, ...rawValue] = cookie.trim().split('=');
    if (rawKey === name) return decodeURIComponent(rawValue.join('='));
  }
  return '';
}

function tokenMatches(candidate, expected) {
  const candidateBuffer = Buffer.from(String(candidate || ''));
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
}

function requireManagementAuth(req, res, next) {
  if (!MANAGEMENT_API_TOKEN) return next();

  const suppliedToken = req.get('x-management-auth') || cookieValue(req.headers.cookie, 'management_api_token');
  if (!tokenMatches(suppliedToken, MANAGEMENT_API_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

app.use(express.json());
app.use('/agents', express.static(path.join(__dirname, 'web')));
app.use('/agents/api', requireManagementAuth);

app.use('/agents/api/agents', agentsRouter);
app.use('/agents/api/jobs', jobsRouter);
app.use('/agents/api/queue', queueRouter);
app.use('/agents/api/activity', activityRouter);
app.use('/agents/api/dispatch', dispatchRouter);
app.use('/agents/api/logs', logsRouter);
app.use('/agents/api/inbox', inboxRouter);
app.use('/agents/api/actions', actionsRouter);
app.use('/agents/api/workflows', workflowsRouter);
app.use('/agents/api/skills', skillsRouter);
app.use('/agents/api/personas', personasRouter);
app.use('/agents/api/toolsets', toolsetsRouter);
app.use('/agents/api/projects', projectsRouter);
app.use('/agents/api/available-tools', availableToolsRouter);
app.use('/agents/api/files', filesRouter);
app.use('/agents/api/health', healthRouter);
app.use('/agents/api/approvals', approvalsRouter);
app.use('/agents/api/channels', channelsRouter);
app.use('/agents/api/budgets', budgetsRouter);
app.use('/agents/api/notifications', notificationsRouter);
app.use('/agents/api/evals', evalsRouter);
app.use('/agents/api/onboarding', onboardingRouter);

app.get('/agents', (req, res) => {
  res.redirect('/agents/');
});
app.get('/agents/', (req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

const BIND_HOST = process.env.MANAGEMENT_BIND_HOST || '127.0.0.1';
app.listen(PORT, BIND_HOST, () => {
  console.log(`Management UI running at http://localhost:${PORT}`);
  console.log(`Management API auth: ${MANAGEMENT_API_TOKEN ? 'enabled' : 'disabled'}`);
});
