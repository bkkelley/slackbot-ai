#!/usr/bin/env node

/**
 * System-control MCP server for the bot's INTERACTIVE Claude session.
 *
 * Gives the session hands to operate the whole system in natural language — list/run/create/delete
 * agents, run/list workflows, manage scheduled jobs + the live queue, list skills, and manage
 * project bindings — by wrapping the management-API (which itself proxies the runtime). This is what
 * makes "run Sage's morning nudge" or "what workflows do I have?" work without a $-command.
 *
 * Spawned by claude-handler with env: MANAGEMENT_PORT, MANAGEMENT_API_TOKEN (optional), SLACK_CONTEXT,
 * SLACK_PLATFORM. All diagnostics go to stderr (stdout is the JSON-RPC channel).
 *
 * GUARDRAIL: destructive/outbound tools say "confirm first" in their description; the model is
 * expected to confirm with the user before calling them (the session runs bypass-permissions).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const log = (msg: string, data?: unknown) =>
  console.error(`[SystemControlMCP] ${msg}${data !== undefined ? ' ' + JSON.stringify(data) : ''}`);

const BASE = `http://127.0.0.1:${process.env.MANAGEMENT_PORT || '3456'}/agents/api`;
const TOKEN = process.env.MANAGEMENT_API_TOKEN || '';
const PLATFORM = process.env.SLACK_PLATFORM || 'slack';
const CTX = process.env.SLACK_CONTEXT
  ? (JSON.parse(process.env.SLACK_CONTEXT) as { channel: string; threadTs?: string; user: string })
  : { channel: '', threadTs: undefined as string | undefined, user: '' };

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['x-management-auth'] = TOKEN;
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await resp.text();
  let data: any;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!resp.ok) throw new Error((data && (data.error || data.message)) || `${method} ${path} → ${resp.status}`);
  return data;
}

const ok = (obj: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const fail = (msg: string) => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });

const CONFIRM = ' DESTRUCTIVE — only call after the user has explicitly confirmed this exact action.';

const TOOLS = [
  // ── Agents ──
  { name: 'ListAgents', description: 'List all agents (name, status, model, scope). Pass scope to see a project\'s agents.',
    inputSchema: { type: 'object', properties: { scope: { type: 'string', description: 'Optional workspace/project name' } } } },
  { name: 'RunAgent', description: 'Dispatch an agent action now; output posts to this channel. Needs the agent name and an action name (see ListAgents / ListActions).',
    inputSchema: { type: 'object', properties: {
      agent: { type: 'string' }, action: { type: 'string' },
      scope: { type: 'string', description: 'Project name for a project-scoped agent (omit for global)' },
    }, required: ['agent', 'action'] } },
  { name: 'CreateAgent', description: 'Create a new agent. Global by default; pass scope to create it inside a project.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string' }, instructions: { type: 'string', description: 'The agent\'s system instructions' },
      model: { type: 'string', description: 'e.g. claude-haiku-4-5-20251001 / sonnet / opus' }, scope: { type: 'string' },
    }, required: ['name', 'instructions'] } },
  { name: 'DeleteAgent', description: 'Delete an agent.' + CONFIRM,
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, scope: { type: 'string' } }, required: ['name'] } },
  { name: 'ListActions', description: 'List action templates (the tasks agents can run). Pass scope for a project\'s actions.',
    inputSchema: { type: 'object', properties: { scope: { type: 'string' } } } },

  // ── Workflows ──
  { name: 'ListWorkflows', description: 'List workflows (sequential multi-step automations).',
    inputSchema: { type: 'object', properties: { scope: { type: 'string' } } } },
  { name: 'RunWorkflow', description: 'Run a named workflow (async by default; posts progress to this channel).',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, mode: { type: 'string', enum: ['async', 'sync'] } }, required: ['name'] } },
  { name: 'DeleteWorkflow', description: 'Delete a workflow.' + CONFIRM,
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },

  // ── Scheduled jobs ──
  { name: 'ListSchedules', description: 'List scheduled jobs (cron entries from jobs.json).', inputSchema: { type: 'object', properties: {} } },
  { name: 'CreateSchedule', description: 'Create/upsert a scheduled job. Provide a cron and either (agent+action), workflow, or command.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string' }, cron: { type: 'string', description: 'cron expression, e.g. "0 9 * * *"' },
      agent: { type: 'string' }, action: { type: 'string' }, workflow: { type: 'string' }, command: { type: 'string' },
      mode: { type: 'string' }, enabled: { type: 'boolean' },
    }, required: ['id', 'cron'] } },
  { name: 'SetScheduleEnabled', description: 'Enable or disable an existing scheduled job by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['id', 'enabled'] } },
  { name: 'DeleteSchedule', description: 'Delete a scheduled job by id.' + CONFIRM,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },

  // ── Live queue ──
  { name: 'ListJobs', description: 'List recent/running jobs in the live queue (status, agent, timing).',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'CancelJob', description: 'Cancel a pending/running job by id.' + CONFIRM,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },

  // ── Skills (running a skill is native to the session via the Skill tool; this just lists them) ──
  { name: 'ListSkills', description: 'List installed Claude Code skills. (To RUN a skill, just use it directly — the session has the Skill tool.)',
    inputSchema: { type: 'object', properties: { scope: { type: 'string' } } } },

  // ── Projects ──
  { name: 'ListProjects', description: 'List projects (workspaces) with their channel/Salesforce/Drive/alias bindings.', inputSchema: { type: 'object', properties: {} } },
  { name: 'MapChannelToProject', description: 'Map a Slack channel to a project. Defaults to THIS channel if channelId is omitted.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, channelId: { type: 'string' } }, required: ['project'] } },
  { name: 'SetProjectBindings', description: 'Set a project\'s Salesforce records, Google Drive folder, and/or DM auto-scope aliases.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string' },
      salesforce: { type: 'object', properties: { org: { type: 'string' }, accountId: { type: 'string' }, projectId: { type: 'string' } } },
      drivePath: { type: 'string' },
      aliases: { type: 'string', description: 'Comma-separated alias names' },
    }, required: ['project'] } },
];

class SystemControlServer {
  private server = new Server({ name: 'system-control', version: '1.0.0' }, { capabilities: { tools: {} } });

  constructor() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const a = (request.params.arguments ?? {}) as Record<string, any>;
      const q = (scope?: string) => (scope ? `?scope=${encodeURIComponent(scope)}` : '');
      try {
        switch (request.params.name) {
          case 'ListAgents': return ok(await api('GET', `/agents${q(a.scope)}`));
          case 'RunAgent': return ok(await api('POST', '/dispatch/run', {
            agent: a.agent, action: a.action, scope: a.scope, mode: 'async', toolset: 'default',
            outputChannel: { platform: PLATFORM, id: CTX.channel },
          }));
          case 'CreateAgent': return ok(await api('POST', '/agents', {
            name: a.name, instructions: a.instructions, model: a.model, scope: a.scope,
          }));
          case 'DeleteAgent': return ok(await api('DELETE', `/agents/${encodeURIComponent(a.name)}${q(a.scope)}`));
          case 'ListActions': return ok(await api('GET', `/actions${q(a.scope)}`));

          case 'ListWorkflows': return ok(await api('GET', `/workflows${q(a.scope)}`));
          case 'RunWorkflow': return ok(await api('POST', `/workflows/${encodeURIComponent(a.name)}/run`, { mode: a.mode || 'async' }));
          case 'DeleteWorkflow': return ok(await api('DELETE', `/workflows/${encodeURIComponent(a.name)}`));

          case 'ListSchedules': return ok(await api('GET', '/jobs'));
          case 'CreateSchedule': return ok(await api('POST', '/jobs', {
            id: a.id, cron: a.cron, agent: a.agent, action: a.action, workflow: a.workflow,
            command: a.command, mode: a.mode || 'async', enabled: a.enabled !== false,
          }));
          case 'SetScheduleEnabled': return ok(await api('PUT', `/jobs/${encodeURIComponent(a.id)}`, { enabled: !!a.enabled }));
          case 'DeleteSchedule': return ok(await api('DELETE', `/jobs/${encodeURIComponent(a.id)}`));

          case 'ListJobs': return ok(await api('GET', `/queue?limit=${Number(a.limit) > 0 ? Math.min(Number(a.limit), 50) : 15}`));
          case 'CancelJob': return ok(await api('DELETE', `/queue/${encodeURIComponent(a.id)}`));

          case 'ListSkills': return ok(await api('GET', `/skills${q(a.scope)}`));

          case 'ListProjects': return ok(await api('GET', '/projects'));
          case 'MapChannelToProject': return ok(await api('POST', `/projects/${encodeURIComponent(a.project)}/channels`, { channelId: a.channelId || CTX.channel }));
          case 'SetProjectBindings': return ok(await api('PUT', `/projects/${encodeURIComponent(a.project)}/bindings`, {
            salesforce: a.salesforce, drivePath: a.drivePath, aliases: a.aliases,
          }));

          default: return fail(`Unknown tool: ${request.params.name}`);
        }
      } catch (err: any) {
        log('tool call failed', { tool: request.params.name, error: err?.message });
        return fail(err?.message ?? String(err));
      }
    });
  }

  async run() {
    await this.server.connect(new StdioServerTransport());
    log('started', { base: BASE });
  }
}

new SystemControlServer().run().catch((error) => {
  log('fatal error', { error: String(error) });
  process.exit(1);
});
