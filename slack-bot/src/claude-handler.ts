import { spawn } from 'child_process';
import { createInterface } from 'readline';
import path from 'path';
import * as fs from 'fs';
import { homedir } from 'os';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager, McpStdioServerConfig } from './mcp-manager';

const QUERY_TIMEOUT_MS = 10 * 60 * 1000;
const CLAUDE_SESSIONS_FILE = path.join(homedir(), '.claude', 'claude-handler-sessions.json');

// Standing guidance for the interactive Slack session. Without it the model improvises when asked
// about "my projects" — e.g. running `gh repo list` and analyzing every GitHub repo instead of the
// projects this system actually knows about. "Projects" here means the registry exposed by the
// system-control ListProjects tool (the workspaces under ~/claude-workspaces), nothing wider.
const PROJECTS_SYSTEM_PROMPT = [
  'When the user refers to "my projects", "the projects", or asks you to analyze, compare, or report',
  'across projects, that means the projects registered in THIS system. Enumerate them with the',
  'system-control ListProjects tool and scope your answer to exactly those projects.',
  'Do NOT enumerate GitHub repositories (e.g. `gh repo list`) or scan the filesystem for git repos to',
  'discover projects — the registry is the source of truth. Only look beyond the registered projects',
  'if the user explicitly asks you to.',
].join(' ');

// Local types matching `claude --output-format stream-json` NDJSON output.
export type SDKMessage =
  | { type: 'system'; subtype: 'init'; session_id: string; [key: string]: unknown }
  | { type: 'assistant'; message: { content: Array<{ type: string; text?: string; name?: string; input?: unknown }> }; [key: string]: unknown }
  | { type: 'result'; subtype: string; result?: string; total_cost_usd?: number; duration_ms?: number; [key: string]: unknown };

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;
  private ipcPort: number;

  constructor(mcpManager: McpManager, ipcPort: number) {
    this.mcpManager = mcpManager;
    this.ipcPort = ipcPort;
    this.loadSessions();
  }

  private loadSessions(): void {
    try {
      if (fs.existsSync(CLAUDE_SESSIONS_FILE)) {
        const data = fs.readFileSync(CLAUDE_SESSIONS_FILE, 'utf-8');
        const sessions = JSON.parse(data);
        for (const [key, session] of Object.entries(sessions)) {
          this.sessions.set(key, {
            ...(session as ConversationSession),
            lastActivity: new Date((session as any).lastActivity),
          });
        }
        this.logger.info(`Loaded ${this.sessions.size} sessions from disk`);
      }
    } catch (error) {
      this.logger.error('Failed to load sessions:', error);
    }
  }

  private saveSessions(): void {
    try {
      const dir = path.dirname(CLAUDE_SESSIONS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data: Record<string, ConversationSession> = {};
      for (const [key, session] of this.sessions.entries()) {
        data[key] = session;
      }
      fs.writeFileSync(CLAUDE_SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error('Failed to save sessions:', error);
    }
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    const session = this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
    if (session) {
      session.lastActivity = new Date();
      this.saveSessions();
    }
    return session;
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    this.sessions.set(this.getSessionKey(userId, channelId, threadTs), session);
    this.saveSessions();
    return session;
  }

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: { channel: string; threadTs?: string; user: string },
    model?: string
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const effectiveController = abortController ?? new AbortController();
    const claudePath = process.env.CLAUDE_PATH || `${process.env.HOME}/.local/bin/claude`;

    // Build allowed tools list
    const allowedTools = ['Task', 'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebSearch', 'Skill'];
    const mcpServers: Record<string, object> = { ...(this.mcpManager.getServerConfiguration() ?? {}) };

    if (slackContext) {
      const isTypescript = __filename.endsWith('.ts');
      const serverFile = path.join(
        __dirname,
        isTypescript ? 'permission-mcp-server.ts' : 'permission-mcp-server.js'
      );
      const [command, ...extraArgs] = isTypescript ? ['npx', 'tsx'] : ['node'];

      const permissionServer: McpStdioServerConfig = {
        command,
        args: [...extraArgs, serverFile],
        env: {
          SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN ?? '',
          SLACK_CONTEXT: JSON.stringify(slackContext),
          PERMISSION_IPC_PORT: String(this.ipcPort),
        },
      };
      mcpServers['permission-prompt'] = permissionServer;

      // Slack-tools server: gives the interactive session canvas / scheduled-message / reminder /
      // list tools, backed by the bot's own transport-proxy, scoped to this conversation.
      const toolsFile = path.join(__dirname, isTypescript ? 'slack-tools-mcp-server.ts' : 'slack-tools-mcp-server.js');
      mcpServers['slack-tools'] = {
        command,
        args: [...extraArgs, toolsFile],
        env: {
          BOT_HTTP_PORT: process.env.BOT_HTTP_PORT ?? '3458',
          BOT_RUNTIME_SHARED_SECRET: process.env.BOT_RUNTIME_SHARED_SECRET ?? '',
          SLACK_CONTEXT: JSON.stringify(slackContext),
          SLACK_PLATFORM: 'slack',
        },
      };

      // Hosted Slack MCP (acts as the authenticated user via OAuth): search/read/post the user's
      // own Slack messages — e.g. "what did I commit to in the last hour". Reuses the keychain
      // token from a one-time `claude → /mcp → slack → Authenticate`. Set SLACK_MCP_ENABLED=false
      // to disable. Tools appear only once authenticated, so it degrades gracefully if not.
      if (process.env.SLACK_MCP_ENABLED !== 'false') {
        mcpServers['slack'] = { type: 'http', url: process.env.SLACK_MCP_URL || 'https://mcp.slack.com/mcp' };
      }

      // MemPalace: optional local long-term memory. Only wired when MEMORY_ENABLED=true; its native
      // stdio MCP server (mempalace-mcp) gives the session search/knowledge-graph tools. Degrades
      // gracefully — if the binary or palace is missing, the tools simply error and are ignored.
      if (process.env.MEMORY_ENABLED === 'true') {
        const memBin = process.env.MEMPALACE_MCP_BIN || `${process.env.HOME}/.local/bin/mempalace-mcp`;
        mcpServers['mempalace'] = { command: memBin, args: [] };
      }

      // System-control: lets the session operate the whole system in natural language (run/list/
      // create/delete agents, workflows, jobs, schedules, projects) by wrapping the management API.
      const sysFile = path.join(__dirname, isTypescript ? 'system-control-mcp-server.ts' : 'system-control-mcp-server.js');
      mcpServers['system-control'] = {
        command,
        args: [...extraArgs, sysFile],
        env: {
          MANAGEMENT_PORT: process.env.MANAGEMENT_PORT ?? '3456',
          MANAGEMENT_API_TOKEN: process.env.MANAGEMENT_API_TOKEN ?? '',
          SLACK_CONTEXT: JSON.stringify(slackContext),
          SLACK_PLATFORM: 'slack',
        },
      };
    }

    const mcpToolPrefixes = this.mcpManager.getDefaultAllowedTools();
    if (slackContext) mcpToolPrefixes.push('mcp__permission-prompt', 'mcp__slack-tools', 'mcp__slack', 'mcp__system-control');
    if (slackContext && process.env.MEMORY_ENABLED === 'true') mcpToolPrefixes.push('mcp__mempalace');
    allowedTools.push(...mcpToolPrefixes);

    const args: string[] = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--permission-mode', 'bypassPermissions',
      '--allowed-tools', allowedTools.join(','),
      '--model', model || 'claude-sonnet-4-6',
    ];

    // Only the interactive Slack session has the system-control MCP (ListProjects). Teach it that
    // "my projects" = the system registry, so it doesn't fall back to sweeping GitHub/the filesystem.
    if (slackContext) {
      args.push('--append-system-prompt', PROJECTS_SYSTEM_PROMPT);
    }

    if (Object.keys(mcpServers).length > 0) {
      args.push('--mcp-config', JSON.stringify({ mcpServers }));
      this.logger.debug('Added MCP config', {
        serverCount: Object.keys(mcpServers).length,
        servers: Object.keys(mcpServers),
      });
    }

    if (session?.sessionId) {
      args.push('--resume', session.sessionId);
      this.logger.debug('Resuming session', { sessionId: session.sessionId });
    } else {
      this.logger.debug('Starting new Claude conversation');
    }

    // Prompt is written to stdin to avoid variadic --allowed-tools consuming it.
    this.logger.debug('Spawning claude', { claudePath, toolCount: allowedTools.length });

    const child = spawn(claudePath, args, {
      cwd: workingDirectory,
      env: { ...process.env },
    });

    child.stdin.write(prompt);
    child.stdin.end();

    // --- Async message queue ---
    const queue: SDKMessage[] = [];
    let wakeup: (() => void) | null = null;
    let processExited = false;

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        queue.push(JSON.parse(trimmed) as SDKMessage);
        wakeup?.();
        wakeup = null;
      } catch {
        this.logger.debug('Unparseable stream-json line', { line: trimmed });
      }
    });

    const exitPromise = new Promise<void>((resolve) => {
      child.on('close', (code) => {
        this.logger.debug('Claude process exited', { code });
        processExited = true;
        wakeup?.();
        wakeup = null;
        resolve();
      });
    });

    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString().trim();
      if (text) this.logger.debug('claude stderr', { text });
    });

    const timeoutId = setTimeout(() => {
      this.logger.warn('Query timed out', { timeoutMs: QUERY_TIMEOUT_MS });
      effectiveController.abort();
    }, QUERY_TIMEOUT_MS);

    effectiveController.signal.addEventListener('abort', () => {
      child.kill();
    }, { once: true });

    // Returns the next parsed message, or null when the process has exited and
    // the queue is empty. Suspends when neither condition is true yet.
    const nextMsg = (): Promise<SDKMessage | null> => {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      if (processExited) return Promise.resolve(null);
      return new Promise((resolve) => {
        wakeup = () => resolve(queue.length > 0 ? queue.shift()! : null);
      });
    };

    try {
      let msg: SDKMessage | null;
      while (!effectiveController.signal.aborted && (msg = await nextMsg()) !== null) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          if (session) {
            session.sessionId = msg.session_id;
            this.logger.info('Session initialized', { sessionId: msg.session_id });
            this.saveSessions();
          }
        }
        yield msg;
      }
    } finally {
      clearTimeout(timeoutId);
      rl.close();
      child.kill();
      await exitPromise;
    }
  }

  cleanupInactiveSessions(maxAge: number = 7 * 24 * 60 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
      this.saveSessions();
    }
  }
}
