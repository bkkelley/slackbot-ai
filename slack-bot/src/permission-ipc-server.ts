import http from 'http';
import { AddressInfo } from 'net';
import { WebClient } from '@slack/web-api';
import { Logger } from './logger';

interface PendingApproval {
  tool_name: string;
  input: unknown;
  requestingUserId: string;
  slackChannel: string;
  slackMessageTs: string;
  resolve: (behavior: 'allow' | 'deny') => void;
  timer: NodeJS.Timeout;
}

export class PermissionIpcServer {
  private server: http.Server;
  private port = 0;
  private pending = new Map<string, PendingApproval>();
  private slack: WebClient;
  private logger = new Logger('PermissionIPC');

  constructor(botToken: string) {
    this.slack = new WebClient(botToken);
    this.server = this.createHttpServer();
  }

  private createHttpServer(): http.Server {
    return http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/permission-request') {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        this.handleRequest(body, res).catch((err) => {
          this.logger.error('IPC request handler error', err);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end(JSON.stringify({ behavior: 'deny' }));
          }
        });
      });
    });
  }

  private async handleRequest(body: string, res: http.ServerResponse): Promise<void> {
    const { approvalId, tool_name, input, channel, thread_ts, user } = JSON.parse(body) as {
      approvalId: string;
      tool_name: string;
      input: unknown;
      channel: string;
      thread_ts?: string;
      user: string;
    };

    let slackTs: string;
    let slackChannel: string;

    try {
      const result = await this.sendSlackMessage(approvalId, tool_name, input, channel, thread_ts, user);
      if (!result.ok || !result.ts || !result.channel) {
        throw new Error('Slack API returned unsuccessful response');
      }
      slackTs = result.ts;
      slackChannel = result.channel;
    } catch (err) {
      this.logger.error('Failed to send Slack permission message', err);
      res.writeHead(500);
      res.end(JSON.stringify({ behavior: 'deny' }));
      return;
    }

    const timer = setTimeout(() => {
      const entry = this.pending.get(approvalId);
      if (entry) {
        this.pending.delete(approvalId);
        this.updateSlackMessage(entry.slackChannel, entry.slackMessageTs, tool_name, 'timeout').catch(() => {});
        entry.resolve('deny');
      }
    }, 5 * 60 * 1000);

    this.pending.set(approvalId, {
      tool_name,
      input,
      requestingUserId: user,
      slackChannel,
      slackMessageTs: slackTs,
      resolve: (behavior) => {
        clearTimeout(timer);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ behavior }));
      },
      timer,
    });
  }

  private async sendSlackMessage(
    approvalId: string,
    tool_name: string,
    input: unknown,
    channel: string,
    thread_ts: string | undefined,
    user: string
  ) {
    const inputPreview = JSON.stringify(input, null, 2).substring(0, 500);
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔐 *Permission Request*\n\nClaude wants to use: \`${tool_name}\`\n\n*Parameters:*\n\`\`\`\n${inputPreview}\n\`\`\``,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Approve' },
            style: 'primary',
            action_id: 'approve_tool',
            value: approvalId,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❌ Deny' },
            style: 'danger',
            action_id: 'deny_tool',
            value: approvalId,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Requested by: <@${user}> · Only you can approve or deny this request`,
          },
        ],
      },
    ];

    return this.slack.chat.postMessage({
      channel: channel || user,
      thread_ts,
      blocks,
      text: `Permission request for ${tool_name}`,
    });
  }

  private async updateSlackMessage(
    channel: string,
    ts: string,
    tool_name: string,
    outcome: 'allow' | 'deny' | 'timeout'
  ): Promise<void> {
    const label =
      outcome === 'allow' ? '✅ Approved' :
      outcome === 'deny'  ? '❌ Denied'   : '⏱️ Timed out';
    try {
      await this.slack.chat.update({
        channel,
        ts,
        text: `Permission ${outcome} for ${tool_name}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `🔐 *Permission Request* — ${label}\n\nTool: \`${tool_name}\``,
            },
          },
        ],
      });
    } catch (err) {
      this.logger.warn('Failed to update permission Slack message', err);
    }
  }

  resolveApproval(approvalId: string, approved: boolean, clickingUserId: string): 'ok' | 'unauthorized' | 'not_found' {
    const entry = this.pending.get(approvalId);
    if (!entry) return 'not_found';
    if (entry.requestingUserId !== clickingUserId) return 'unauthorized';

    this.pending.delete(approvalId);
    const outcome = approved ? 'allow' : 'deny';
    entry.resolve(outcome);
    this.updateSlackMessage(entry.slackChannel, entry.slackMessageTs, entry.tool_name, outcome).catch(() => {});
    return 'ok';
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as AddressInfo).port;
        this.logger.info('Permission IPC server started', { port: this.port });
        resolve(this.port);
      });
      this.server.on('error', reject);
    });
  }

  getPort(): number {
    return this.port;
  }

  close(): void {
    this.server.close();
  }
}
