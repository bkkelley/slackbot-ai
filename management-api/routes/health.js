const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { baseDirectory, vaultPath } = require('../../shared/config');
const { safeJoin } = require('../../shared/path-guard');

const router = express.Router();

const RUNTIME_API_URL = `http://127.0.0.1:${process.env.RUNTIME_HTTP_PORT || '3457'}`;
const BOT_RUNTIME_SHARED_SECRET = process.env.BOT_RUNTIME_SHARED_SECRET || '';
const INCIDENT_STATE_PATH = process.env.HEALTH_INCIDENT_STATE_PATH || path.join(__dirname, '..', 'data', 'health-incidents.json');
const INCIDENT_CARD_THRESHOLD = 3;

function runtimeHeaders() {
  return { 'Content-Type': 'application/json', 'X-Bot-Auth': BOT_RUNTIME_SHARED_SECRET };
}

async function runtimeJson(pathname) {
  const response = await fetch(`${RUNTIME_API_URL}${pathname}`, { headers: runtimeHeaders() });
  if (!response.ok) throw new Error(`runtime ${response.status}`);
  return response.json();
}

async function runtimePost(pathname, body) {
  const response = await fetch(`${RUNTIME_API_URL}${pathname}`, {
    method: 'POST',
    headers: runtimeHeaders(),
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `runtime ${response.status}`);
  return data;
}

function logInfo(label, filePath) {
  const exists = fs.existsSync(filePath);
  const stat = exists ? fs.statSync(filePath) : null;
  return {
    label,
    path: filePath,
    exists,
    size: stat ? stat.size : 0,
    modifiedAt: stat ? stat.mtime.toISOString() : null,
  };
}

function incident(id, severity, title, detail, extras = {}) {
  const runbook = incidentRunbook(id, extras);
  return {
    id,
    severity,
    title,
    detail,
    source: extras.source || 'system',
    cause: extras.cause || runbook.cause,
    likelyFix: extras.likelyFix || runbook.likelyFix,
    relatedLogs: extras.relatedLogs || runbook.relatedLogs,
    evidence: extras.evidence || [],
    actions: extras.actions || [],
    detectedAt: new Date().toISOString(),
  };
}

function action(label, type, target, extras = {}) {
  return { label, type, target, ...extras };
}

function incidentRunbook(id, extras = {}) {
  if (id === 'runtime-offline') {
    return {
      cause: 'The runtime HTTP API is not responding to the management API.',
      likelyFix: 'Restart the agent runtime and inspect runtime.log if it does not come back.',
      relatedLogs: [{ label: 'runtime', target: 'runtime' }],
    };
  }
  if (id === 'recent-job-failures') {
    return {
      cause: 'One or more recent jobs ended in failed status.',
      likelyFix: 'Open the queue, inspect failed job detail, then check runtime.log for execution errors.',
      relatedLogs: [{ label: 'runtime', target: 'runtime' }],
    };
  }
  if (id === 'stale-running-jobs') {
    return {
      cause: 'A job has exceeded the expected runtime window.',
      likelyFix: 'Open the queue to inspect the active job. Restart runtime only if the job is clearly stuck.',
      relatedLogs: [{ label: 'runtime', target: 'runtime' }],
    };
  }
  if (id === 'queue-backlog') {
    return {
      cause: 'Jobs are being enqueued faster than workers are clearing them.',
      likelyFix: 'Review running jobs and worker health, then clear stalled work or increase throughput.',
      relatedLogs: [{ label: 'runtime', target: 'runtime' }],
    };
  }
  if (id.startsWith('missing-path-')) {
    return {
      cause: 'A configured workspace or vault path is unavailable.',
      likelyFix: 'Verify the directory exists and that the management process can read it.',
      relatedLogs: [],
    };
  }
  if (id.startsWith('disabled-schedule-')) {
    return {
      cause: 'A core scheduled automation is disabled.',
      likelyFix: 'Enable the schedule if the automation is still expected to run.',
      relatedLogs: [{ label: 'runtime', target: 'runtime' }],
    };
  }
  if (id.startsWith('stale-schedule-')) {
    return {
      cause: 'An enabled schedule has not recorded a recent run.',
      likelyFix: 'Open schedules, verify the cron definition, and check runtime.log for scheduler errors.',
      relatedLogs: [{ label: 'runtime', target: 'runtime' }],
    };
  }
  if (id.startsWith('missing-log-')) {
    return {
      cause: 'A configured log file is missing.',
      likelyFix: 'Confirm the service has started and that the log path is correct.',
      relatedLogs: [],
    };
  }
  if (id.startsWith('stale-log-')) {
    return {
      cause: 'A service log has not been updated recently.',
      likelyFix: 'Confirm whether the service should be active; restart only if it is expected to be producing work.',
      relatedLogs: [{ label: extras.logLabel || id.replace('stale-log-', ''), target: extras.logLabel || id.replace('stale-log-', '') }],
    };
  }
  if (id.startsWith('log-errors-')) {
    const log = extras.logLabel || id.replace('log-errors-', '');
    return {
      cause: 'Recent error entries were found in a service log.',
      likelyFix: 'Open the related log, identify the top repeated error, and restart or repair the owning service.',
      relatedLogs: [{ label: log, target: log }],
    };
  }
  if (id.startsWith('log-warnings-')) {
    const log = extras.logLabel || id.replace('log-warnings-', '');
    return {
      cause: 'Warnings are repeating in a service log.',
      likelyFix: 'Inspect the warning pattern and decide whether it is expected noise or a degraded service.',
      relatedLogs: [{ label: log, target: log }],
    };
  }
  return {
    cause: 'The health check matched a known degraded system condition.',
    likelyFix: 'Review the evidence and run the most specific action listed for this incident.',
    relatedLogs: [],
  };
}

function loadIncidentState() {
  try {
    if (!fs.existsSync(INCIDENT_STATE_PATH)) return {};
    return JSON.parse(fs.readFileSync(INCIDENT_STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveIncidentState(state) {
  fs.mkdirSync(path.dirname(INCIDENT_STATE_PATH), { recursive: true });
  fs.writeFileSync(INCIDENT_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function yamlScalar(value) {
  return JSON.stringify(String(value ?? ''));
}

function cardTimestamp(date = new Date()) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`;
}

function filenameTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function slugForIncident(id) {
  return String(id || 'incident')
    .replace(/[^A-Za-z0-9 _.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'incident';
}

function incidentCardContent(incident) {
  const lines = [
    `# ${incident.title}`,
    '',
    `Severity: ${incident.severity}`,
    `Source: ${incident.source}`,
    `First seen: ${incident.firstSeen}`,
    `Last seen: ${incident.lastSeen}`,
    `Occurrences: ${incident.occurrenceCount}`,
    '',
    '## Cause',
    incident.cause || 'Unknown.',
    '',
    '## Likely Fix',
    incident.likelyFix || 'Review the incident evidence and related logs.',
    '',
    '## Details',
    incident.detail || '',
  ];

  if (incident.evidence?.length) {
    lines.push('', '## Evidence', ...incident.evidence.map(item => `- ${item}`));
  }
  if (incident.relatedLogs?.length) {
    lines.push('', '## Related Logs', ...incident.relatedLogs.map(item => `- ${item.label || item.target}`));
  }
  if (incident.actions?.length) {
    lines.push('', '## Actions', ...incident.actions.map(item => `- ${item.label}`));
  }
  return `${lines.join('\n')}\n`;
}

function writeIncidentCard(incident) {
  const now = new Date();
  const created = cardTimestamp(now);
  const filename = `System Incident - ${slugForIncident(incident.id)} - ${filenameTimestamp(now)}.md`;
  const cardDir = safeJoin(vaultPath, 'Card');
  const filePath = safeJoin(cardDir, filename);
  const frontmatter = [
    '---',
    'fileClass: Card',
    'favorite: false',
    'archived: false',
    'tags:',
    '  - cards',
    '  - system-incident',
    `created: ${created}`,
    `modified: ${created}`,
    'card-type: System Incident',
    `incident-id: ${yamlScalar(incident.id)}`,
    `severity: ${yamlScalar(incident.severity)}`,
    `source: ${yamlScalar(incident.source)}`,
    `title: ${yamlScalar(incident.title)}`,
    `first-seen: ${yamlScalar(incident.firstSeen)}`,
    `last-seen: ${yamlScalar(incident.lastSeen)}`,
    `occurrence-count: ${incident.occurrenceCount || 0}`,
    '---',
    '',
  ].join('\n');

  fs.mkdirSync(cardDir, { recursive: true });
  fs.writeFileSync(filePath, frontmatter + incidentCardContent(incident), 'utf8');
  return filename;
}

function enrichIncidentState(incidents) {
  const now = new Date().toISOString();
  const state = loadIncidentState();
  let changed = false;

  for (const incident of incidents) {
    const previous = state[incident.id] || {};
    const occurrenceCount = (previous.occurrenceCount || 0) + 1;
    Object.assign(incident, {
      firstSeen: previous.firstSeen || now,
      lastSeen: now,
      occurrenceCount,
      incidentCard: previous.incidentCard || null,
      cardWriteError: previous.cardWriteError || null,
    });

    if (occurrenceCount >= INCIDENT_CARD_THRESHOLD && !previous.incidentCard && incident.severity !== 'info') {
      try {
        incident.incidentCard = writeIncidentCard(incident);
        incident.cardWriteError = null;
      } catch (err) {
        incident.cardWriteError = err.message;
      }
    }

    state[incident.id] = {
      firstSeen: incident.firstSeen,
      lastSeen: incident.lastSeen,
      occurrenceCount: incident.occurrenceCount,
      severity: incident.severity,
      title: incident.title,
      incidentCard: incident.incidentCard,
      cardWriteError: incident.cardWriteError,
    };
    changed = true;
  }

  for (const [id, item] of Object.entries(state)) {
    if (incidents.some(incident => incident.id === id)) continue;
    state[id] = { ...item, inactiveSince: item.inactiveSince || now };
    changed = true;
  }

  if (changed) saveIncidentState(state);
  return incidents;
}

function readRecentLines(filePath, maxBytes = 160_000) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8').split('\n').filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

function parseLogEntry(line) {
  try {
    const parsed = JSON.parse(line);
    return {
      level: String(parsed.level || '').toLowerCase(),
      name: parsed.name || '',
      msg: parsed.msg || '',
      ts: parsed.ts || null,
      raw: line,
    };
  } catch {
    const match = line.match(/^\[([^\]]+)\]\s+\[(ERROR|WARN|INFO|DEBUG)\]\s+\[([^\]]+)\]\s+(.+)$/i);
    if (!match) return { level: '', name: '', msg: line, ts: null, raw: line };
    return {
      ts: match[1],
      level: match[2].toLowerCase(),
      name: match[3],
      msg: match[4],
      raw: line,
    };
  }
}

function logSignals(logs) {
  const sinceMs = Date.now() - 48 * 60 * 60 * 1000;
  const signals = [];
  for (const log of logs) {
    if (!log.exists) continue;
    const entries = readRecentLines(log.path).map(parseLogEntry).filter((entry) => {
      if (!entry.ts) return true;
      const time = new Date(entry.ts).getTime();
      return Number.isNaN(time) || time >= sinceMs;
    });
    const errors = entries.filter(entry => entry.level === 'error');
    const warnings = entries.filter(entry => entry.level === 'warn');
    const byMessage = new Map();
    for (const entry of [...errors, ...warnings]) {
      const key = `${entry.level}:${entry.name}:${entry.msg}`;
      const current = byMessage.get(key) || { ...entry, count: 0 };
      current.count += 1;
      byMessage.set(key, current);
    }
    signals.push({
      log: log.label,
      errors,
      warnings,
      top: Array.from(byMessage.values()).sort((a, b) => b.count - a.count).slice(0, 5),
    });
  }
  return signals;
}

function scheduleAgeWarning(schedule) {
  if (!schedule.enabled || !schedule.lastRun || !schedule.cron) return null;
  const ageHours = (Date.now() - new Date(schedule.lastRun).getTime()) / 36e5;
  if (Number.isNaN(ageHours)) return null;
  if (schedule.cron.includes('* * * *') && ageHours > 2) return `${Math.round(ageHours)}h since last run`;
  if (schedule.cron.includes('* * *') && ageHours > 30) return `${Math.round(ageHours)}h since last run`;
  return null;
}

function runLaunchctl(label) {
  return new Promise((resolve, reject) => {
    execFile('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function buildIncidents(health, context) {
  const incidents = [];
  const { jobs, schedules, logSignals: signals } = context;

  if (!health.runtime.ok) {
    incidents.push(incident(
      'runtime-offline',
      'critical',
      'Agent runtime is offline',
      health.runtime.error || 'The management API could not reach the runtime API.',
      {
        source: 'runtime',
        relatedLogs: [{ label: 'runtime', target: 'runtime' }],
        actions: [
          action('Restart runtime', 'api', 'restart-runtime', { variant: 'danger' }),
          action('Open runtime log', 'log', 'runtime'),
        ],
      }
    ));
  }

  const failedJobs = jobs.filter(job => job.status === 'failed');
  if (failedJobs.length > 0) {
    incidents.push(incident(
      'recent-job-failures',
      failedJobs.length > 3 ? 'critical' : 'warning',
      `${failedJobs.length} recent job failure${failedJobs.length === 1 ? '' : 's'}`,
      'The recent queue contains failed jobs that may need review.',
      {
        source: 'queue',
        relatedLogs: [{ label: 'runtime', target: 'runtime' }],
        evidence: failedJobs.slice(0, 4).map(job => `${job.agent || job.workflow || job.id}: ${job.result?.error || job.status}`),
        actions: [action('Open queue', 'navigate', 'jobs'), action('Open runtime log', 'log', 'runtime')],
      }
    ));
  }

  const staleRunning = jobs.filter(job => job.status === 'running' && job.startedAt && Date.now() - new Date(job.startedAt).getTime() > 45 * 60 * 1000);
  if (staleRunning.length > 0) {
    incidents.push(incident(
      'stale-running-jobs',
      'warning',
      `${staleRunning.length} long-running job${staleRunning.length === 1 ? '' : 's'}`,
      'A job has been running for more than 45 minutes.',
      {
        source: 'queue',
        relatedLogs: [{ label: 'runtime', target: 'runtime' }],
        evidence: staleRunning.slice(0, 3).map(job => `${job.agent || job.workflow || job.id} started ${job.startedAt}`),
        actions: [action('Open queue', 'navigate', 'jobs'), action('Open runtime log', 'log', 'runtime')],
      }
    ));
  }

  if (health.queue.pending > 8) {
    incidents.push(incident(
      'queue-backlog',
      'warning',
      'Queue backlog is growing',
      `${health.queue.pending} jobs are pending.`,
      { source: 'queue', relatedLogs: [{ label: 'runtime', target: 'runtime' }], actions: [action('Open queue', 'navigate', 'jobs')] }
    ));
  }

  for (const [key, item] of Object.entries(health.paths)) {
    if (!item.exists) {
      incidents.push(incident(
        `missing-path-${key}`,
        key === 'inbox' ? 'info' : 'critical',
        `${key} path is missing`,
        item.path,
        { source: 'paths', actions: [action('Open files', 'navigate', 'files')] }
      ));
    }
  }

  const disabledCore = schedules.filter(schedule =>
    schedule.enabled === false && ['obsidian-backup', 'extract-ppao', 'extract-projects', 'extract-sources', 'extract-tags'].includes(schedule.id)
  );
  for (const schedule of disabledCore) {
    incidents.push(incident(
      `disabled-schedule-${schedule.id}`,
      schedule.id === 'obsidian-backup' ? 'critical' : 'warning',
      `Core schedule is disabled: ${schedule.id}`,
      schedule.description || schedule.command || `${schedule.agent || 'job'} ${schedule.action || ''}`.trim(),
      {
        source: 'schedules',
        actions: [
          action('Enable schedule', 'api', `enable-schedule:${schedule.id}`),
          action('Open schedules', 'navigate', 'jobs'),
        ],
      }
    ));
  }

  for (const schedule of schedules) {
    const warning = scheduleAgeWarning(schedule);
    if (!warning) continue;
    incidents.push(incident(
      `stale-schedule-${schedule.id}`,
      'warning',
      `Schedule may be stale: ${schedule.id}`,
      warning,
      { source: 'schedules', relatedLogs: [{ label: 'runtime', target: 'runtime' }], actions: [action('Open schedules', 'navigate', 'jobs'), action('Open runtime log', 'log', 'runtime')] }
    ));
  }

  for (const log of health.logs) {
    if (!log.exists) {
      incidents.push(incident(
        `missing-log-${log.label}`,
        'warning',
        `Missing log: ${log.label}`,
        log.path,
        { source: 'logs' }
      ));
      continue;
    }
    if (log.modifiedAt && Date.now() - new Date(log.modifiedAt).getTime() > 48 * 60 * 60 * 1000) {
      incidents.push(incident(
        `stale-log-${log.label}`,
        'info',
        `Log has been quiet: ${log.label}`,
        `Last modified ${log.modifiedAt}`,
        { source: 'logs', logLabel: log.label, relatedLogs: [{ label: log.label, target: log.label }], actions: [action('Open log', 'log', log.label)] }
      ));
    }
  }

  for (const signal of signals) {
    if (signal.errors.length > 0) {
      incidents.push(incident(
        `log-errors-${signal.log}`,
        'critical',
        `${signal.errors.length} recent error log${signal.errors.length === 1 ? '' : 's'} in ${signal.log}`,
        signal.top.find(item => item.level === 'error')?.msg || 'Recent error entries were found.',
        {
          source: 'logs',
          logLabel: signal.log,
          relatedLogs: [{ label: signal.log, target: signal.log }],
          evidence: signal.top.filter(item => item.level === 'error').slice(0, 3).map(item => `${item.count}x ${item.name}: ${item.msg}`),
          actions: [action('Open log', 'log', signal.log)],
        }
      ));
    } else if (signal.warnings.length >= 5) {
      incidents.push(incident(
        `log-warnings-${signal.log}`,
        'warning',
        `${signal.warnings.length} recent warnings in ${signal.log}`,
        signal.top.find(item => item.level === 'warn')?.msg || 'Recent warning entries were found.',
        {
          source: 'logs',
          logLabel: signal.log,
          relatedLogs: [{ label: signal.log, target: signal.log }],
          evidence: signal.top.filter(item => item.level === 'warn').slice(0, 3).map(item => `${item.count}x ${item.name}: ${item.msg}`),
          actions: [action('Open log', 'log', signal.log)],
        }
      ));
    }
  }

  return incidents.sort((a, b) => ({ critical: 0, warning: 1, info: 2 }[a.severity] - { critical: 0, warning: 1, info: 2 }[b.severity]));
}

router.get('/', async (_req, res) => {
  const inboxPath = fs.existsSync(path.join(vaultPath, 'Inbox'))
    ? path.join(vaultPath, 'Inbox')
    : path.join(vaultPath, '_inbox');
  const health = {
    runtime: { ok: false, error: null },
    queue: { total: 0, pending: 0, running: 0, done: 0, failed: 0 },
    schedules: { total: 0, enabled: 0 },
    incidents: [],
    incidentSummary: { critical: 0, warning: 0, info: 0 },
    paths: {
      baseDirectory: { path: baseDirectory, exists: fs.existsSync(baseDirectory) },
      vaultPath: { path: vaultPath, exists: fs.existsSync(vaultPath) },
      inbox: { path: inboxPath, exists: fs.existsSync(inboxPath), count: 0 },
    },
    logs: [
      logInfo('runtime', path.join(baseDirectory, 'system/agent-runtime/runtime.log')),
      logInfo('bot', path.join(baseDirectory, 'system/slack-bot/bot.log')),
      logInfo('inbox-processor', path.join(vaultPath, 'Meta/inbox-processor.log')),
    ],
  };
  let jobs = [];
  let schedules = [];

  try {
    const data = await runtimeJson('/api/jobs?limit=100');
    jobs = data.jobs || [];
    health.runtime.ok = true;
    health.queue.total = jobs.length;
    for (const job of jobs) {
      if (health.queue[job.status] !== undefined) health.queue[job.status]++;
    }
  } catch (err) {
    health.runtime.error = err.message;
  }

  try {
    const data = await runtimeJson('/api/schedules');
    schedules = data.schedules || [];
    health.schedules.total = schedules.length;
    health.schedules.enabled = schedules.filter(job => job.enabled !== false).length;
  } catch {}

  try {
    const inboxPath = health.paths.inbox.path;
    if (fs.existsSync(inboxPath)) {
      health.paths.inbox.count = fs.readdirSync(inboxPath).filter(name => !name.startsWith('.')).length;
    }
  } catch {}

  health.incidents = enrichIncidentState(buildIncidents(health, { jobs, schedules, logSignals: logSignals(health.logs) }));
  for (const item of health.incidents) {
    if (health.incidentSummary[item.severity] !== undefined) health.incidentSummary[item.severity]++;
  }

  res.json(health);
});

router.post('/actions/:actionId', async (req, res) => {
  const actionId = req.params.actionId;
  try {
    if (actionId === 'restart-runtime') {
      await runLaunchctl('com.slackbot.runtime');
      return res.json({ ok: true, message: 'Runtime restart requested.' });
    }
    if (actionId === 'restart-bot') {
      await runLaunchctl('com.slackbot.bot');
      return res.json({ ok: true, message: 'Bot restart requested.' });
    }
    if (actionId.startsWith('enable-schedule:')) {
      const id = actionId.slice('enable-schedule:'.length);
      const data = await runtimeJson('/api/schedules');
      const schedule = (data.schedules || []).find(item => item.id === id);
      if (!schedule) return res.status(404).json({ error: `Schedule not found: ${id}` });
      await runtimePost('/api/schedules', { ...schedule, enabled: true });
      return res.json({ ok: true, message: `Schedule enabled: ${id}` });
    }
    res.status(400).json({ error: `Unknown health action: ${actionId}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
