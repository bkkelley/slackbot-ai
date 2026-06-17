const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const SDK_TOOLS = [
  { name: 'Bash',               category: 'File & Code',            description: 'Run shell commands' },
  { name: 'Read',               category: 'File & Code',            description: 'Read files' },
  { name: 'Write',              category: 'File & Code',            description: 'Create or overwrite files' },
  { name: 'Edit',               category: 'File & Code',            description: 'Modify existing files (diff-based)' },
  { name: 'Glob',               category: 'File & Code',            description: 'Pattern-match files by name' },
  { name: 'Grep',               category: 'File & Code',            description: 'Search file contents' },
  { name: 'EnterPlanMode',      category: 'Planning & Design',      description: 'Design approach, get user approval before acting' },
  { name: 'ExitPlanMode',       category: 'Planning & Design',      description: 'Finalize and exit plan mode' },
  { name: 'AskUserQuestion',    category: 'Planning & Design',      description: 'Ask user multiple-choice or open questions' },
  { name: 'TaskCreate',         category: 'Task Management',        description: 'Create a tracked task' },
  { name: 'TaskList',           category: 'Task Management',        description: 'List all tasks' },
  { name: 'TaskGet',            category: 'Task Management',        description: 'Fetch a specific task by ID' },
  { name: 'TaskUpdate',         category: 'Task Management',        description: 'Update task status or description' },
  { name: 'TaskOutput',         category: 'Task Management',        description: 'Get output from a background task' },
  { name: 'TaskStop',           category: 'Task Management',        description: 'Stop a running task' },
  { name: 'Agent',              category: 'Agents & Skills',        description: 'Spawn a specialized sub-agent' },
  { name: 'Skill',              category: 'Agents & Skills',        description: 'Run a Claude Code skill by name' },
  { name: 'Monitor',            category: 'Monitoring & Scheduling', description: 'Stream output from long-running processes' },
  { name: 'CronCreate',         category: 'Monitoring & Scheduling', description: 'Schedule a recurring cron job' },
  { name: 'CronDelete',         category: 'Monitoring & Scheduling', description: 'Delete a cron job' },
  { name: 'CronList',           category: 'Monitoring & Scheduling', description: 'List all scheduled cron jobs' },
  { name: 'ScheduleWakeup',     category: 'Monitoring & Scheduling', description: 'Self-pace iterations in /loop mode' },
  { name: 'EnterWorktree',      category: 'Worktrees',              description: 'Create an isolated git worktree' },
  { name: 'ExitWorktree',       category: 'Worktrees',              description: 'Leave worktree, keep or discard changes' },
  { name: 'WebSearch',          category: 'Web & Notifications',    description: 'Search the web' },
  { name: 'WebFetch',           category: 'Web & Notifications',    description: 'Fetch and analyze URL content' },
  { name: 'PushNotification',   category: 'Web & Notifications',    description: 'Send a desktop or mobile notification' },
  { name: 'RemoteTrigger',      category: 'Web & Notifications',    description: 'Call claude.ai remote-trigger API' },
  { name: 'NotebookEdit',       category: 'Notebooks',              description: 'Edit Jupyter notebook cells' },
  { name: 'ShareOnboardingGuide', category: 'Misc',                 description: 'Upload ONBOARDING.md and get a share link' },
  { name: 'ListMcpResourcesTool', category: 'Misc',                 description: 'List available MCP resources' },
  { name: 'ReadMcpResourceTool',  category: 'Misc',                 description: 'Read a specific MCP resource' },
  { name: 'ToolSearch',           category: 'Misc',                 description: 'Fetch schemas for deferred tools before calling them' },
];

const AGENT_RUNTIME_TOOLS = [
  { name: 'PostMessage',   description: 'Post a message to the job\'s Slack or Discord output channel', file: 'post-message.ts' },
  { name: 'WriteCard',     description: 'Write a markdown card to admin/Card/', file: 'write-card.ts' },
  { name: 'UpdateCard',    description: 'Update an existing card by cardId', file: 'update-card.ts' },
  { name: 'SpawnAgent',    description: 'Spawn a child agent job (sync runs inline, async queues normally)', file: 'spawn-agent.ts' },
  { name: 'WaitForJob',    description: 'Block until an async job completes (max 600s)', file: 'wait-for-job.ts' },
  { name: 'GetJobStatus',  description: 'Return the current status of any job by ID', file: 'get-job-status.ts' },
  { name: 'RunSkill',      description: 'Execute a Claude Code skill by name as a child job', file: 'run-skill.ts' },
  { name: 'RunWorkflow',   description: 'Execute a named workflow from admin/_workflows/', file: 'run-workflow.ts' },
];

const BASE_DIRECTORY = process.env.BASE_DIRECTORY || `${process.env.HOME}/claude-workspaces`;

function readMcpServers(settingsPath) {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    return JSON.parse(raw).mcpServers || {};
  } catch {
    return {};
  }
}

router.get('/', (req, res) => {
  const mcpServers = readMcpServers(path.join(__dirname, '../../slack-bot/mcp-servers.json'));

  let projectMcpServers = null;
  if (req.query.scope) {
    const resolved = path.resolve(BASE_DIRECTORY, String(req.query.scope), '.claude', 'settings.json');
    if (resolved.startsWith(path.resolve(BASE_DIRECTORY) + path.sep)) {
      projectMcpServers = readMcpServers(resolved);
    }
  }

  res.json({ sdkTools: SDK_TOOLS, agentRuntimeTools: AGENT_RUNTIME_TOOLS, mcpServers, projectMcpServers });
});

module.exports = router;
