const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { vaultPath, agentWorkspacesDir, schedulerDir } = require('./config');
const { writeAgent, deleteAgentFile } = require('./vault');
const { assertSafeSegment, safeJoin } = require('./path-guard');

const LAUNCH_AGENTS_DIR = path.join(process.env.HOME, 'Library/LaunchAgents');

function createAgent({ name, instructions, model = 'claude-haiku-4-5-20251001', cadence = 'On demand', triggerType = 'none', triggerConfig = {} }) {
  name = assertSafeSegment(name, 'agent name');
  const now = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 17) + '000';
  const workspaceDir = safeJoin(agentWorkspacesDir, name.toLowerCase());
  const claudeMdPath = path.join(workspaceDir, 'CLAUDE.md');
  const settingsDir = path.join(workspaceDir, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  const vaultFilePath = `~/.claude/agents/${name}.md`;

  // 1. Create agent file
  const frontmatter = {
    fileClass: 'Agent',
    'agent-name': name,
    status: 'Active',
    cadence,
    'last-session': '',
    model,
    tags: ['agents'],
    created: now,
    modified: now,
  };

  const body = `# ${name}

---

## Instructions

${instructions}

---

## Configuration

| Field | Value |
|-------|-------|
| Workspace | \`claude-workspaces/${name.toLowerCase()}/\` |
| Model | \`${model}\` |
| Trigger | ${triggerType} |
| Cadence | ${cadence} |

---

## Recent activity

\`\`\`datacorejs
// Datacore query: Agent Log Cards where agent = [[${name}]],
// sorted by created desc, limit 10
\`\`\`
`;

  writeAgent(name, frontmatter, body);

  // 2. Create workspace directory
  fs.mkdirSync(settingsDir, { recursive: true });

  // 3. Create CLAUDE.md (one-liner pointing to agent file)
  fs.writeFileSync(claudeMdPath, `Before doing anything, read \`${vaultFilePath}\` for your full instructions.\n`, 'utf8');

  // 4. Create .claude/settings.json
  fs.writeFileSync(settingsPath, JSON.stringify({
    permissions: { allow: ['Read(*)', 'Edit(*)', 'Write(*)', 'Glob(*)', 'Grep(*)'] }
  }, null, 2), 'utf8');

  // 5. Wire up trigger
  let triggerDetails = null;
  if (triggerType === 'launchagent') {
    triggerDetails = createLaunchAgent(name, workspaceDir, triggerConfig);
  } else if (triggerType === 'scheduler') {
    triggerDetails = createSchedulerJob(name, workspaceDir, triggerConfig);
  }

  return { name, workspaceDir, triggerType, triggerDetails };
}

function createLaunchAgent(name, workspaceDir, { intervalMinutes = 60, prompt = 'Run your scheduled task.' }) {
  name = assertSafeSegment(name, 'agent name');
  const label = `com.slackbot.agent-${name.toLowerCase()}`;
  const scriptPath = path.join(workspaceDir, 'run.sh');
  const logPath = path.join(workspaceDir, 'agent.log');
  const plistPath = path.join(LAUNCH_AGENTS_DIR, `${label}.plist`);

  // Create run script
  const claudePath = require('./config').claudePath;
  fs.writeFileSync(scriptPath, `#!/bin/bash
/usr/bin/env ${claudePath} --print "${prompt}" --workdir "${workspaceDir}" >> "${logPath}" 2>&1
`, 'utf8');
  fs.chmodSync(scriptPath, '755');

  // Create plist
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${scriptPath}</string>
  </array>
  <key>StartInterval</key>
  <integer>${intervalMinutes * 60}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plist, 'utf8');
  spawnSync('launchctl', ['load', plistPath]);

  return { label, plistPath, scriptPath, logPath, intervalMinutes };
}

function createSchedulerJob(name, workspaceDir, { cron, prompt = 'Run your scheduled task.', slackChannel }) {
  name = assertSafeSegment(name, 'agent name');
  const jobsPath = path.join(schedulerDir, 'jobs.json');
  const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
  const id = `agent-${name.toLowerCase()}`;

  jobs.push({
    id,
    scheduleType: 'recurring',
    cron,
    prompt,
    workingDir: workspaceDir,
    slackChannel: slackChannel || null,
    enabled: true,
    lastRun: null,
    createdAt: new Date().toISOString(),
  });

  fs.writeFileSync(jobsPath, JSON.stringify(jobs, null, 2), 'utf8');
  return { id, cron };
}

function deleteAgent(name, { removeWorkspace = false } = {}) {
  name = assertSafeSegment(name, 'agent name');
  const workspaceDir = safeJoin(agentWorkspacesDir, name.toLowerCase());
  const label = `com.slackbot.agent-${name.toLowerCase()}`;
  const plistPath = path.join(LAUNCH_AGENTS_DIR, `${label}.plist`);

  // Unload and remove LaunchAgent if exists
  if (fs.existsSync(plistPath)) {
    spawnSync('launchctl', ['unload', plistPath]);
    fs.unlinkSync(plistPath);
  }

  // Disable scheduler job if exists
  const jobsPath = path.join(schedulerDir, 'jobs.json');
  if (fs.existsSync(jobsPath)) {
    const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
    const id = `agent-${name.toLowerCase()}`;
    const idx = jobs.findIndex(j => j.id === id);
    if (idx !== -1) {
      jobs[idx].enabled = false;
      fs.writeFileSync(jobsPath, JSON.stringify(jobs, null, 2), 'utf8');
    }
  }

  // Remove workspace directory if requested
  if (removeWorkspace && fs.existsSync(workspaceDir)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }

  // Remove agent file
  deleteAgentFile(name);

  return { name, workspaceRemoved: removeWorkspace };
}

module.exports = { createAgent, deleteAgent };
