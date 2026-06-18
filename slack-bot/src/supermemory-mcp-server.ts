#!/usr/bin/env node

/**
 * Supermemory MCP server for the bot's INTERACTIVE Claude session (@mention / DM).
 *
 * Exposes explicit Recall + Memory tools backed by the self-hosted Supermemory server
 * (default http://localhost:6767). Spawned by claude-handler ONLY when SUPERMEMORY_ENABLED=true,
 * so it's a fully optional feature. Env: SUPERMEMORY_URL, SUPERMEMORY_API_KEY, SLACK_CONTEXT.
 *
 * Recall  → POST /v3/search    (semantic search over stored content chunks)
 * Memory  → POST /v3/documents (store text for later recall)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// stdio MCP server — stdout is the JSON-RPC channel. ALL diagnostics go to stderr.
const log = (msg: string, data?: unknown) =>
  console.error(`[SupermemoryMCP] ${msg}${data !== undefined ? ' ' + JSON.stringify(data) : ''}`);

const BASE = process.env.SUPERMEMORY_URL || 'http://localhost:6767';
const KEY = process.env.SUPERMEMORY_API_KEY || '';
const CTX = process.env.SLACK_CONTEXT
  ? (JSON.parse(process.env.SLACK_CONTEXT) as { channel: string; threadTs?: string; user: string })
  : { channel: '', threadTs: undefined as string | undefined, user: '' };

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (KEY) h['Authorization'] = `Bearer ${KEY}`;
  return h;
}

const ok = (obj: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const fail = (msg: string) => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });

const TOOLS = [
  {
    name: 'Recall',
    description: 'Search long-term memory for facts, preferences, or context saved earlier. Use when a request might depend on something the user told you before (their preferences, project details, past decisions).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall (natural language).' },
        limit: { type: 'number', description: 'Max results (default 5).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'Memory',
    description: 'Save a durable fact, preference, or decision to long-term memory so it can be recalled in future conversations. Store concise, self-contained statements (e.g. "Acme bills monthly, not annually").',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact/preference to remember, as a self-contained sentence.' },
      },
      required: ['content'],
    },
  },
];

class SupermemoryServer {
  private server = new Server({ name: 'supermemory', version: '1.0.0' }, { capabilities: { tools: {} } });

  constructor() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const a = (request.params.arguments ?? {}) as Record<string, any>;
      try {
        switch (request.params.name) {
          case 'Recall': {
            const r = await fetch(`${BASE}/v3/search`, {
              method: 'POST', headers: headers(),
              body: JSON.stringify({ q: String(a.query || '').slice(0, 500) }),
              signal: AbortSignal.timeout(5000),
            });
            if (!r.ok) return fail(`search failed (${r.status})`);
            const data = (await r.json()) as { results?: Array<{ chunks?: Array<{ content?: string; score?: number; isRelevant?: boolean }> }> };
            const limit = Number(a.limit) > 0 ? Math.min(Number(a.limit), 20) : 5;
            const seen = new Set<string>();
            const hits = (data.results || [])
              .flatMap((res) => res.chunks || [])
              .filter((c) => c.content && (c.isRelevant ?? true))
              .map((c) => ({ content: c.content!.trim(), score: c.score ?? 0 }))
              .sort((x, y) => y.score - x.score)
              .filter((h) => (seen.has(h.content) ? false : seen.add(h.content)))
              .slice(0, limit);
            return ok({ hits });
          }
          case 'Memory': {
            const r = await fetch(`${BASE}/v3/documents`, {
              method: 'POST', headers: headers(),
              body: JSON.stringify({
                content: String(a.content || '').slice(0, 8000),
                metadata: { user: CTX.user, channel: CTX.channel, source: 'slack' },
              }),
              signal: AbortSignal.timeout(5000),
            });
            if (!r.ok) return fail(`store failed (${r.status})`);
            const data = (await r.json()) as { id?: string; status?: string };
            return ok({ saved: true, id: data.id, status: data.status });
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
    log('started', { base: BASE });
  }
}

new SupermemoryServer().run().catch((error) => {
  log('fatal error', { error: String(error) });
  process.exit(1);
});
