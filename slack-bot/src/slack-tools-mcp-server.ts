#!/usr/bin/env node

/**
 * Slack-tools MCP server for the bot's INTERACTIVE Claude session (@mention / DM).
 *
 * The interactive session otherwise only has the standard coding tools, so it couldn't create
 * canvases, schedule messages, add reminders, or manage Slack lists — those tools previously
 * existed only for runtime agents. This server exposes them by calling the bot's own
 * transport-proxy (the same HTTP endpoints the runtime uses), scoped to the current conversation
 * via the SLACK_CONTEXT env var.
 *
 * Spawned by claude-handler with env: BOT_HTTP_PORT, BOT_RUNTIME_SHARED_SECRET, SLACK_CONTEXT, SLACK_PLATFORM.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// IMPORTANT: this is a stdio MCP server — stdout is the JSON-RPC channel. All diagnostics MUST go
// to stderr (console.error); a single stray stdout write corrupts the protocol and the tools never
// register. (Do not import the shared Logger here — it logs INFO to stdout.)
const log = (msg: string, data?: unknown) =>
  console.error(`[SlackToolsMCP] ${msg}${data !== undefined ? ' ' + JSON.stringify(data) : ''}`);

const PORT = process.env.BOT_HTTP_PORT || '3458';
const SECRET = process.env.BOT_RUNTIME_SHARED_SECRET || '';
const PLATFORM = process.env.SLACK_PLATFORM || 'slack';
const CTX = process.env.SLACK_CONTEXT
  ? (JSON.parse(process.env.SLACK_CONTEXT) as { channel: string; threadTs?: string; user: string })
  : { channel: '', threadTs: undefined as string | undefined, user: '' };

async function proxy(path: string, payload: Record<string, unknown>): Promise<any> {
  const resp = await fetch(`http://127.0.0.1:${PORT}/api/transport-proxy/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bot-Auth': SECRET },
    body: JSON.stringify({ platform: PLATFORM, ...payload }),
  });
  const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!resp.ok || data.ok === false) {
    throw new Error(data.error || `transport-proxy ${path} failed (${resp.status})`);
  }
  return data;
}

const ok = (obj: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const fail = (msg: string) => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });

// Accept a unix-seconds number, a unix-ms number, or an ISO/parseable date string → unix seconds.
function toUnixSeconds(value: unknown): number {
  if (typeof value === 'number') return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) throw new Error(`Could not parse time: ${String(value)}`);
  return Math.floor(parsed / 1000);
}

const TOOLS = [
  {
    name: 'WriteCanvas',
    description: 'Create (or update) a Slack canvas from Markdown, granted privately to the requesting user. Omit canvasId to create a new one. Returns a permalink — ALWAYS share it so the user can open the canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Canvas title (new canvas only)' },
        markdown: { type: 'string', description: 'Canvas body in Markdown' },
        canvasId: { type: 'string', description: 'Existing canvas id to update (optional)' },
      },
      required: ['markdown'],
    },
  },
  {
    name: 'ScheduleMessage',
    description: 'Schedule a message to post later in the current channel/thread. `at` accepts a unix timestamp or an ISO date.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text' },
        at: { type: ['string', 'number'], description: 'When to post (unix seconds or ISO 8601)' },
      },
      required: ['text', 'at'],
    },
  },
  {
    name: 'ListScheduledMessages',
    description: 'List pending scheduled messages for the current channel.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'CancelScheduledMessage',
    description: 'Cancel a pending scheduled message by id.',
    inputSchema: {
      type: 'object',
      properties: { scheduledMessageId: { type: 'string' } },
      required: ['scheduledMessageId'],
    },
  },
  {
    name: 'AddReminder',
    description: 'Add a native Slack reminder for the current user. `time` accepts a unix timestamp or natural language Slack understands (e.g. "in 2 hours").',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        time: { type: ['string', 'number'] },
      },
      required: ['text', 'time'],
    },
  },
  {
    name: 'CreateTaskList',
    description: 'Create a Slack List (requires a paid plan). Returns its listId and a permalink — ALWAYS share the permalink URL with the user so they can open the list (a bot-created list is otherwise not visible to them).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'AddTask',
    description:
      'Add an item to a Slack List by listId. Pass the columnId returned as primaryColumnId by CreateTaskList. ' +
      'If you created the list in this same session you may omit columnId — it is remembered automatically. ' +
      'Slack has no API to look a list\'s columns back up after creation, so columnId cannot be auto-resolved for a pre-existing list.',
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string' },
        text: { type: 'string' },
        columnId: { type: 'string', description: 'The primaryColumnId from CreateTaskList. Optional if the list was created this session.' },
      },
      required: ['listId', 'text'],
    },
  },
  {
    name: 'ListTasks',
    description: 'List items in a Slack List by listId.',
    inputSchema: {
      type: 'object',
      properties: { listId: { type: 'string' } },
      required: ['listId'],
    },
  },
];

class SlackToolsServer {
  private server = new Server({ name: 'slack-tools', version: '1.0.0' }, { capabilities: { tools: {} } });
  // Slack returns a list's column schema ONLY in the slackLists.create response — there is no API to
  // read columns back later. Remember each list's primary column so AddTask works without the model
  // having to thread columnId through every call within a session.
  private listColumns = new Map<string, string>();

  constructor() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const a = (request.params.arguments ?? {}) as Record<string, any>;
      try {
        switch (request.params.name) {
          case 'WriteCanvas': {
            // Standalone canvas granted to just the requesting user (not the whole channel).
            const r = await proxy('canvas', { title: a.title, markdown: a.markdown, canvasId: a.canvasId, grantUserId: CTX.user });
            return ok({ canvasId: r.canvasId, permalink: r.permalink });
          }
          case 'ScheduleMessage': {
            const r = await proxy('schedule-message', { channelId: CTX.channel, threadId: CTX.threadTs, text: a.text, postAt: toUnixSeconds(a.at) });
            return ok({ scheduledMessageId: r.scheduledMessageId, postAt: r.postAt });
          }
          case 'ListScheduledMessages': {
            const r = await proxy('list-scheduled', { channelId: CTX.channel });
            return ok({ messages: r.messages });
          }
          case 'CancelScheduledMessage': {
            await proxy('cancel-scheduled', { channelId: CTX.channel, scheduledMessageId: a.scheduledMessageId });
            return ok({ cancelled: true });
          }
          case 'AddReminder': {
            const r = await proxy('reminder', { userId: CTX.user, text: a.text, time: a.time });
            return ok({ reminderId: r.reminderId });
          }
          case 'CreateTaskList': {
            const r = await proxy('task', { op: 'create-list', name: a.name, grantUserId: CTX.user });
            if (r.listId && r.primaryColumnId) this.listColumns.set(r.listId, r.primaryColumnId);
            return ok({ listId: r.listId, primaryColumnId: r.primaryColumnId, permalink: r.permalink });
          }
          case 'AddTask': {
            const columnId = a.columnId ?? this.listColumns.get(a.listId);
            const r = await proxy('task', { op: 'add', listId: a.listId, text: a.text, columnId });
            return ok({ itemId: r.itemId });
          }
          case 'ListTasks': {
            const r = await proxy('task', { op: 'list', listId: a.listId });
            return ok({ items: r.items });
          }
          default:
            return fail(`Unknown tool: ${request.params.name}`);
        }
      } catch (err: any) {
        log('tool call failed', { tool: request.params.name, error: err?.message });
        return fail(err?.message ?? String(err));
      }
    });
  }

  async run() {
    await this.server.connect(new StdioServerTransport());
    log('started');
  }
}

new SlackToolsServer().run().catch((error) => {
  log('fatal error', { error: String(error) });
  process.exit(1);
});
