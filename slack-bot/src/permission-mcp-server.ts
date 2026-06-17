#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Logger } from './logger.js';

const logger = new Logger('PermissionMCP');

interface PermissionRequest {
  tool_name: string;
  input: unknown;
}

class PermissionMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      { name: 'permission-prompt', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'permission_prompt',
          description: 'Request user permission for tool execution via Slack',
          inputSchema: {
            type: 'object',
            properties: {
              tool_name: { type: 'string', description: 'Name of the tool requesting permission' },
              input: { type: 'object', description: 'Input parameters for the tool' },
            },
            required: ['tool_name', 'input'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'permission_prompt') {
        return await this.handlePermissionPrompt(request.params.arguments as unknown as PermissionRequest);
      }
      throw new Error(`Unknown tool: ${request.params.name}`);
    });
  }

  private async handlePermissionPrompt(params: PermissionRequest) {
    const ipcPort = process.env.PERMISSION_IPC_PORT;
    if (!ipcPort) {
      logger.error('PERMISSION_IPC_PORT not set — denying by default');
      return {
        content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: 'IPC not configured' }) }],
      };
    }

    const slackContext = process.env.SLACK_CONTEXT
      ? (JSON.parse(process.env.SLACK_CONTEXT) as { channel: string; threadTs?: string; user: string })
      : { channel: '', user: '' };

    const approvalId = `approval_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

    try {
      const response = await fetch(`http://127.0.0.1:${ipcPort}/permission-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvalId,
          tool_name: params.tool_name,
          input: params.input,
          channel: slackContext.channel,
          thread_ts: slackContext.threadTs,
          user: slackContext.user,
        }),
      });

      if (!response.ok) {
        throw new Error(`IPC server responded with ${response.status}`);
      }

      const result = await response.json() as { behavior: 'allow' | 'deny' };
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      logger.error('Failed to reach permission IPC server', error);
      return {
        content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: 'IPC communication failed' }) }],
      };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('Permission MCP server started');
  }
}

const permissionServer = new PermissionMCPServer();
permissionServer.run().catch((error) => {
  logger.error('Permission MCP server fatal error:', error);
  process.exit(1);
});
