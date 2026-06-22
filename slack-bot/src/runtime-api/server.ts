import * as http from 'http';
import { Logger } from '../logger';
import { ChannelTransport } from '../orchestration/types';

export class RuntimeApiServer {
  private server: http.Server;
  private logger = new Logger('RuntimeApiServer');
  private transports = new Map<string, ChannelTransport>();

  constructor(
    private port: number,
    private sharedSecret: string,
    defaultTransport: ChannelTransport
  ) {
    this.transports.set(defaultTransport.platform, defaultTransport);
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.logger.error('RuntimeAPI request error', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
        }
      });
    });
  }

  registerTransport(transport: ChannelTransport): void {
    this.transports.set(transport.platform, transport);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '127.0.0.1', () => {
        this.logger.info('RuntimeAPI server started', { port: this.port });
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  close(): void {
    this.server.close();
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const authHeader = req.headers['x-bot-auth'];
    if (!authHeader || authHeader !== this.sharedSecret) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }

    const url = req.url ?? '';
    const method = req.method ?? '';

    if (method === 'GET' && url === '/api/permission-config') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'permissions bypassed' }));
      return;
    }

    if (method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      return;
    }

    let body: Record<string, any>;
    try {
      body = await this.readBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
      return;
    }

    const platform: string = body.platform ?? 'slack';
    const transport = this.transports.get(platform);
    if (!transport) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `No transport registered for platform: ${platform}` }));
      return;
    }

    if (url === '/api/transport-proxy/send') {
      try {
        const { channelId, threadId, text } = body as { channelId: string; threadId?: string; text: string };
        const result = await transport.send(channelId, threadId, text);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, messageId: result.messageId }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
      }
      return;
    }

    if (url === '/api/transport-proxy/approval') {
      try {
        const { channelId, threadId, approvalId, prompt } = body as {
          channelId: string; threadId?: string; approvalId: string; prompt: string;
        };
        if (!transport.sendWorkflowApproval) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'approval messages unsupported for this transport' }));
          return;
        }
        const result = await transport.sendWorkflowApproval(channelId, threadId, approvalId, prompt);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, messageId: result.messageId }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
      }
      return;
    }

    if (url === '/api/transport-proxy/upload') {
      try {
        const { channelId, threadId, filename, contentBase64 } = body as {
          channelId: string; threadId?: string; filename: string; contentBase64: string;
        };
        const file = Buffer.from(contentBase64, 'base64');
        await transport.uploadFile(channelId, threadId, file, filename);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
      }
      return;
    }

    if (url === '/api/transport-proxy/react') {
      if (!transport.supports('reactions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unsupported' }));
        return;
      }
      try {
        const { channelId, messageId, emoji, action } = body as {
          channelId: string; messageId: string; emoji: string; action: 'add' | 'remove';
        };
        if (action === 'add') {
          await transport.react!(channelId, messageId, emoji);
        } else {
          await transport.removeReaction!(channelId, messageId, emoji);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
      }
      return;
    }

    if (url === '/api/transport-proxy/canvas') {
      if (!transport.createCanvas) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'canvases unsupported for this transport' }));
        return;
      }
      try {
        const { canvasId, title, markdown, channelId, grantUserId } = body as {
          canvasId?: string; title?: string; markdown: string; channelId?: string; grantUserId?: string;
        };
        if (canvasId) {
          if (!transport.editCanvas) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'canvas edit unsupported for this transport' }));
            return;
          }
          await transport.editCanvas(canvasId, markdown);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, canvasId }));
        } else {
          const result = await transport.createCanvas(title ?? 'Untitled', markdown, channelId, grantUserId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, canvasId: result.canvasId, permalink: result.permalink }));
        }
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
      }
      return;
    }

    if (url === '/api/transport-proxy/schedule-message') {
      if (!transport.scheduleMessage) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'scheduled messages unsupported for this transport' }));
        return;
      }
      try {
        const { channelId, threadId, text, postAt } = body as {
          channelId: string; threadId?: string; text: string; postAt: number;
        };
        const result = await transport.scheduleMessage(channelId, threadId, text, postAt);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, scheduledMessageId: result.scheduledMessageId, postAt: result.postAt }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
      }
      return;
    }

    if (url === '/api/transport-proxy/list-scheduled') {
      if (!transport.listScheduledMessages) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'scheduled messages unsupported for this transport' }));
        return;
      }
      try {
        const { channelId } = body as { channelId?: string };
        const messages = await transport.listScheduledMessages(channelId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, messages }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
      }
      return;
    }

    if (url === '/api/transport-proxy/cancel-scheduled') {
      if (!transport.cancelScheduledMessage) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'scheduled messages unsupported for this transport' }));
        return;
      }
      try {
        const { channelId, scheduledMessageId } = body as { channelId: string; scheduledMessageId: string };
        await transport.cancelScheduledMessage(channelId, scheduledMessageId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
      }
      return;
    }

    if (url === '/api/transport-proxy/reminder') {
      if (!transport.addReminder) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'reminders unsupported for this transport' }));
        return;
      }
      try {
        const { userId, text, time } = body as { userId: string; text: string; time: string | number };
        const result = await transport.addReminder(userId, text, time);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, reminderId: result.reminderId }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
      }
      return;
    }

    if (url === '/api/transport-proxy/task') {
      if (!transport.createTaskList || !transport.addTask || !transport.listTasks) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'lists/tasks unsupported for this transport' }));
        return;
      }
      try {
        const { op, name, listId, text, columnId, grantUserId } = body as {
          op: 'create-list' | 'add' | 'list'; name?: string; listId?: string; text?: string; columnId?: string; grantUserId?: string;
        };
        if (op === 'create-list') {
          const result = await transport.createTaskList(name ?? 'Tasks', grantUserId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, listId: result.listId, primaryColumnId: result.primaryColumnId, permalink: result.permalink }));
        } else if (op === 'add') {
          if (!listId || !text) throw new Error('listId and text are required');
          const result = await transport.addTask(listId, text, columnId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, itemId: result.itemId }));
        } else if (op === 'list') {
          if (!listId) throw new Error('listId is required');
          const items = await transport.listTasks(listId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, items }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `Unknown task op: ${op}` }));
        }
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
      }
      return;
    }

    // Read-as-the-owner via the user token (search / channel history).
    if (url === '/api/transport-proxy/read') {
      if (!transport.searchMessages || !transport.readChannelMessages) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'user-token reads unsupported for this transport' }));
        return;
      }
      try {
        const { op, query, channelId, limit, count } = body as {
          op: 'search' | 'history'; query?: string; channelId?: string; limit?: number; count?: number;
        };
        if (op === 'search') {
          if (!query) throw new Error('query is required');
          const matches = await transport.searchMessages(query, count);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, matches }));
        } else if (op === 'history') {
          if (!channelId) throw new Error('channelId is required');
          const messages = await transport.readChannelMessages(channelId, limit);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, messages }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `Unknown read op: ${op}` }));
        }
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  }

  private readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      req.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }
}
