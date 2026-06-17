#!/usr/bin/env node
// src/mcp/server.ts — runs as stdio MCP server, one per job

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const RUNTIME_IPC_PORT = process.env.RUNTIME_IPC_PORT;
const JOB_ID = process.env.JOB_ID;

if (!RUNTIME_IPC_PORT || !JOB_ID) {
  process.stderr.write('RUNTIME_IPC_PORT and JOB_ID must be set\n');
  process.exit(1);
}

async function callIpc(
  tool: string,
  input: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const resp = await fetch(`http://127.0.0.1:${RUNTIME_IPC_PORT}/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: JOB_ID, tool, input }),
    });
    const data = await resp.json();
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg }) }],
    };
  }
}

async function callIpcGet(
  path: string
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const resp = await fetch(`http://127.0.0.1:${RUNTIME_IPC_PORT}${path}`);
    const data = await resp.json();
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg }) }],
    };
  }
}

const server = new Server(
  { name: 'agent-tools', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'PostMessage',
      description: 'Post a message to Slack (or another platform channel)',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text to post' },
          channel: {
            type: 'object',
            description: 'Override channel (optional)',
            properties: {
              platform: { type: 'string' },
              id: { type: 'string' },
            },
            required: ['platform', 'id'],
          },
          threadId: {
            type: 'string',
            description: 'Thread timestamp/ID to reply in (optional)',
          },
          notificationKind: {
            type: 'string',
            enum: ['normal', 'failure'],
            description: 'Notification policy kind for this message',
          },
          notificationSeverity: {
            type: 'string',
            enum: ['info', 'warn', 'error', 'critical'],
            description: 'Severity used by notification policy thresholds',
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'WriteCard',
      description: 'Write an agent log card to the vault',
      inputSchema: {
        type: 'object',
        properties: {
          yaml: {
            type: 'string',
            description: 'YAML frontmatter fields for the card',
          },
          content: {
            type: 'string',
            description: 'Markdown body of the card (optional)',
          },
        },
        required: ['yaml'],
      },
    },
    {
      name: 'UpdateCard',
      description: 'Update a card previously written this run',
      inputSchema: {
        type: 'object',
        properties: {
          cardId: {
            type: 'string',
            description: 'Card ID returned by WriteCard',
          },
          yaml: { type: 'string', description: 'Updated YAML frontmatter' },
          content: { type: 'string', description: 'Updated body (optional)' },
        },
        required: ['cardId', 'yaml'],
      },
    },
    {
      name: 'SpawnAgent',
      description: 'Spawn a child agent job',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent name (vault-based)' },
          action: { type: 'string', description: 'Action name' },
          prompt: { type: 'string', description: 'Raw prompt (alternative to agent/action)' },
          mode: {
            type: 'string',
            enum: ['sync', 'async'],
            description: 'sync = wait for result, async = fire and forget',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'File paths to inject',
          },
          replyText: { type: 'string', description: 'Reply text to inject' },
          outputChannel: {
            type: 'object',
            properties: {
              platform: { type: 'string' },
              id: { type: 'string' },
            },
            required: ['platform', 'id'],
          },
          threadId: { type: 'string' },
          toolset: {
            type: 'string',
            enum: ['default', 'extended'],
          },
          model: { type: 'string', description: 'Claude model override for the child job' },
        },
        required: ['mode'],
      },
    },
    {
      name: 'WaitForJob',
      description: 'Wait for a previously spawned async job to complete',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Job ID to wait for' },
          timeoutSeconds: {
            type: 'number',
            description: 'Max seconds to wait (default 300)',
          },
        },
        required: ['jobId'],
      },
    },
    {
      name: 'GetJobStatus',
      description: 'Get the current status of a job',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Job ID to check' },
        },
        required: ['jobId'],
      },
    },
    {
      name: 'RunWorkflow',
      description: 'Run a named workflow from admin/_workflows/<name>.md. Executes steps sequentially, threading output between steps.',
      inputSchema: {
        type: 'object',
        properties: {
          workflow: { type: 'string', description: 'Workflow name (e.g. "Morning Routine")' },
          mode: { type: 'string', enum: ['sync', 'async'], description: 'sync = wait for all steps (default), async = fire and forget' },
          outputChannel: {
            type: 'object',
            properties: { platform: { type: 'string' }, id: { type: 'string' } },
            required: ['platform', 'id'],
          },
          threadId: { type: 'string' },
          toolset: { type: 'string', enum: ['default', 'extended'] },
          model: { type: 'string', description: 'Claude model override for this workflow run' },
        },
        required: ['workflow'],
      },
    },
    {
      name: 'RunSkill',
      description: 'Run a Claude Code skill by name. Reads the skill markdown file from ~/.claude/commands/<skill>.md and executes it as a child job.',
      inputSchema: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Skill name (e.g. "frontend-design", "update-docs")' },
          args: { type: 'string', description: 'Additional context or arguments appended to the skill prompt (optional)' },
          mode: { type: 'string', enum: ['sync', 'async'], description: 'sync = wait for result (default), async = fire and forget' },
          outputChannel: {
            type: 'object',
            properties: { platform: { type: 'string' }, id: { type: 'string' } },
            required: ['platform', 'id'],
          },
          threadId: { type: 'string', description: 'Thread ID to post output into (optional)' },
          toolset: { type: 'string', enum: ['default', 'extended'] },
          model: { type: 'string', description: 'Claude model override for this skill run' },
        },
        required: ['skill'],
      },
    },
    {
      name: 'WriteCanvas',
      description: 'Create a Slack canvas (rich, persistent document), or append markdown to an existing one. With a channel available the canvas is channel-tabbed (works on free plans); a standalone canvas needs a paid plan. Use for durable, formatted output (summaries, plans, dashboards) rather than a chat message.',
      inputSchema: {
        type: 'object',
        properties: {
          markdown: { type: 'string', description: 'Canvas content as markdown' },
          title: { type: 'string', description: 'Canvas title (for newly-created canvases)' },
          canvasId: { type: 'string', description: 'If set, append markdown to this existing canvas instead of creating a new one' },
          channel: {
            type: 'object',
            description: 'Override channel (optional); defaults to the job output channel',
            properties: { platform: { type: 'string' }, id: { type: 'string' } },
            required: ['platform', 'id'],
          },
        },
        required: ['markdown'],
      },
    },
    {
      name: 'ScheduleMessage',
      description: "Schedule a message to post to a channel at a future time via Slack's chat.scheduleMessage (up to 120 days out). Preferred, durable path for time-based delivery.",
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text to post' },
          postAt: { type: 'number', description: 'Unix timestamp in SECONDS for when to post' },
          channel: {
            type: 'object',
            description: 'Override channel (optional); defaults to the job output channel',
            properties: { platform: { type: 'string' }, id: { type: 'string' } },
            required: ['platform', 'id'],
          },
          threadId: { type: 'string', description: 'Thread ID to post into (optional)' },
        },
        required: ['text', 'postAt'],
      },
    },
    {
      name: 'ListScheduledMessages',
      description: 'List pending scheduled messages (optionally for one channel).',
      inputSchema: {
        type: 'object',
        properties: {
          channel: {
            type: 'object',
            properties: { platform: { type: 'string' }, id: { type: 'string' } },
            required: ['platform', 'id'],
          },
        },
      },
    },
    {
      name: 'CancelScheduledMessage',
      description: 'Cancel a previously scheduled message by its scheduled-message ID.',
      inputSchema: {
        type: 'object',
        properties: {
          scheduledMessageId: { type: 'string', description: 'ID returned by ScheduleMessage / ListScheduledMessages' },
          channel: {
            type: 'object',
            properties: { platform: { type: 'string' }, id: { type: 'string' } },
            required: ['platform', 'id'],
          },
        },
        required: ['scheduledMessageId'],
      },
    },
    {
      name: 'AddReminder',
      description: 'Create a native Slack reminder for a user (reminders.add). The reminders API is degraded/on a retirement path — prefer ScheduleMessage for durable delivery; use this only when the native reminder UX is specifically wanted.',
      inputSchema: {
        type: 'object',
        properties: {
          userId: { type: 'string', description: 'Slack user ID to remind (e.g. "U12345")' },
          text: { type: 'string', description: 'Reminder text' },
          time: { type: 'string', description: 'Unix seconds, seconds-from-now, or natural language ("in 30 minutes", "tomorrow at 9am")' },
        },
        required: ['userId', 'text', 'time'],
      },
    },
    {
      name: 'CreateTaskList',
      description: 'Create a Slack List for tracking tasks (requires a paid Slack plan). Returns a listId used by AddTask/ListTasks.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name for the task list' },
        },
        required: ['name'],
      },
    },
    {
      name: 'AddTask',
      description: 'Add a task (item) to a Slack List by listId.',
      inputSchema: {
        type: 'object',
        properties: {
          listId: { type: 'string', description: 'List ID from CreateTaskList' },
          text: { type: 'string', description: 'Task text' },
          columnId: { type: 'string', description: 'Target text column ID (optional; resolved automatically if omitted)' },
        },
        required: ['listId', 'text'],
      },
    },
    {
      name: 'ListTasks',
      description: 'List the tasks (items) in a Slack List by listId.',
      inputSchema: {
        type: 'object',
        properties: {
          listId: { type: 'string', description: 'List ID to read' },
        },
        required: ['listId'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'PostMessage':
      return callIpc('PostMessage', args);
    case 'WriteCard':
      return callIpc('WriteCard', args);
    case 'UpdateCard':
      return callIpc('UpdateCard', args);
    case 'SpawnAgent':
      return callIpc('SpawnAgent', args);
    case 'WaitForJob':
      return callIpc('WaitForJob', args);
    case 'GetJobStatus': {
      const jobId = (args as { jobId: string }).jobId;
      return callIpcGet(
        `/tool/GetJobStatus?jobId=${encodeURIComponent(jobId)}&callerJobId=${encodeURIComponent(JOB_ID!)}`
      );
    }
    case 'RunWorkflow':
      return callIpc('RunWorkflow', args);
    case 'RunSkill':
      return callIpc('RunSkill', args);
    case 'WriteCanvas':
      return callIpc('WriteCanvas', args);
    case 'ScheduleMessage':
      return callIpc('ScheduleMessage', args);
    case 'ListScheduledMessages':
      return callIpc('ListScheduledMessages', args);
    case 'CancelScheduledMessage':
      return callIpc('CancelScheduledMessage', args);
    case 'AddReminder':
      return callIpc('AddReminder', args);
    case 'CreateTaskList':
      return callIpc('CreateTaskList', args);
    case 'AddTask':
      return callIpc('AddTask', args);
    case 'ListTasks':
      return callIpc('ListTasks', args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch((err) => {
  process.stderr.write(`MCP server fatal error: ${err}\n`);
  process.exit(1);
});
