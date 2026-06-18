import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ChannelTransport, ChannelFormatter, IncomingMessage } from './types';
import { ClaudeHandler, SDKMessage } from '../claude-handler';
import { McpManager } from './mcp-manager';
import { SessionManager } from './session-manager';
import { resolveProject, projectPreamble, sanitizeProject, detectProjectInText } from './channel-projects';
import { memoryEnabled, recall, recallPreamble } from './memory';
import { TodoManager, Todo } from './todo-manager';
import { RateLimiter } from './rate-limiter';
import { ModelManager } from './model-manager';
import { normalizeToolUse } from './tool-normalizer';
import { ProjectCommand } from './commands/project';
import { OnboardCommand } from './commands/onboard';
import { McpCommand } from './commands/mcp';
import { JobsCommand } from './commands/jobs';
import { AgentsCommand } from './commands/agents';
import { HelpCommand } from './commands/help';
import { ModelCommand } from './commands/model';
import { SkillsCommand } from './commands/skills';
import { WorkflowsCommand } from './commands/workflows';
import { TasksCommand } from './commands/tasks';
import { AgentHandler, isAgentChannel } from '../agent-handler';
import { Logger } from '../logger';

const HTML_OUTPUTS_DIR = `${process.env.HOME}/server/html-outputs`;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:3456';

export class MessageProcessor {
  private activeControllers: Map<string, AbortController> = new Map();
  private logger = new Logger('MessageProcessor');
  private sessionManager: SessionManager = new SessionManager();
  private threadProjects: Map<string, string> = new Map(); // DM threadKey → project (via `project: X`)
  private todoManager: TodoManager = new TodoManager();
  private rateLimiter: RateLimiter = new RateLimiter(20, 60_000);
  private modelManager: ModelManager = new ModelManager();
  private todoMessages: Map<string, string> = new Map();
  private originalMessages: Map<string, { channelId: string; messageId: string }> = new Map();
  private currentReactions: Map<string, string> = new Map();
  private agentHandler: AgentHandler = new AgentHandler();
  private projectCommand: ProjectCommand = new ProjectCommand();
  private onboardCommand: OnboardCommand = new OnboardCommand();
  private mcpCommand: McpCommand;
  private jobsCommand: JobsCommand;
  private agentsCommand: AgentsCommand = new AgentsCommand();
  private skillsCommand: SkillsCommand = new SkillsCommand();
  private workflowsCommand: WorkflowsCommand = new WorkflowsCommand();
  private helpCommand: HelpCommand = new HelpCommand();
  private modelCommand: ModelCommand;
  private tasksCommand: TasksCommand;

  constructor(
    private transport: ChannelTransport,
    private formatter: ChannelFormatter,
    private claudeHandler: ClaudeHandler,
    private mcpManager: McpManager,
  ) {
    this.mcpCommand = new McpCommand(this.mcpManager);
    this.jobsCommand = new JobsCommand();
    this.modelCommand = new ModelCommand(this.modelManager);
    this.tasksCommand = new TasksCommand(this.transport);

    // Session cleanup interval
    setInterval(() => {
      this.logger.debug('Running session cleanup');
      this.claudeHandler.cleanupInactiveSessions();
      this.sessionManager.cleanupInactiveSessions();
    }, 5 * 60 * 1000);
  }

  /**
   * Create a Slack-bolt-compatible `say` adapter from transport primitives.
   * Commands expect `say({ text, thread_ts })` or `say({ text })`.
   * Returns { ts } for result tracking.
   */
  private makeSay(channelId: string, defaultThreadId?: string): (args: { text: string; thread_ts?: string } | string) => Promise<{ ts: string }> {
    return async (args) => {
      const text = typeof args === 'string' ? args : args.text;
      const threadId = typeof args === 'object' ? (args.thread_ts ?? defaultThreadId) : defaultThreadId;
      const result = await this.transport.send(channelId, threadId, text);
      return { ts: result.messageId };
    };
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { channelId, threadId, messageId, userId, text, files, isDM } = msg;

    // Rate limiting
    if (!this.rateLimiter.isAllowed(userId)) {
      await this.transport.send(
        channelId,
        threadId || messageId,
        '⚠️ You are sending requests too quickly. Please wait a moment before trying again.'
      );
      return;
    }

    // Process attached files
    let processedFiles: Array<{
      path: string;
      name: string;
      mimeType: string;
      isImage: boolean;
      isText: boolean;
      size: number;
      tempPath?: string;
    }> = [];

    if (files && files.length > 0) {
      this.logger.info('Processing uploaded files', { count: files.length });
      for (const file of files) {
        try {
          if (file.size > 50 * 1024 * 1024) {
            this.logger.warn('File too large, skipping', { name: file.name, size: file.size });
            continue;
          }
          const buffer = await this.transport.downloadFile(file);
          const safeName = path.basename(file.name).replace(/[^\w\-.]/g, '_');
          const tempPath = path.join(os.tmpdir(), `slack-file-${Date.now()}-${safeName}`);
          fs.writeFileSync(tempPath, buffer);

          const isImage = file.mimeType.startsWith('image/');
          const textTypes = ['text/', 'application/json', 'application/javascript', 'application/typescript', 'application/xml', 'application/yaml', 'application/x-yaml'];
          const isText = textTypes.some(t => file.mimeType.startsWith(t));

          processedFiles.push({ path: tempPath, name: file.name, mimeType: file.mimeType, isImage, isText, size: file.size, tempPath });
        } catch (error) {
          this.logger.error(`Failed to process file ${file.name}`, error);
        }
      }

      if (processedFiles.length > 0) {
        await this.transport.send(
          channelId,
          threadId || messageId,
          `📎 Processing ${processedFiles.length} file(s): ${processedFiles.map(f => f.name).join(', ')}`
        );
      }
    }

    if (!text && processedFiles.length === 0) return;

    this.logger.debug('Received message', {
      userId, channelId, threadId, messageId,
      text: text ? text.substring(0, 100) + (text.length > 100 ? '...' : '') : '[no text]',
      fileCount: processedFiles.length,
    });

    const effectiveThreadId = threadId || messageId;
    const say = this.makeSay(channelId, effectiveThreadId);

    const ctx = {
      text: text || '',
      user: userId,
      channel: channelId,
      thread_ts: threadId,
      ts: messageId,
      say,
    };

    // Command routing
    if (text && await this.helpCommand.handle(ctx)) return;
    if (text && await this.onboardCommand.handle(ctx)) return;
    if (text && await this.projectCommand.handle(ctx)) return;
    if (text && await this.modelCommand.handle(ctx)) return;
    if (text && await this.mcpCommand.handle(ctx)) return;
    if (text && await this.jobsCommand.handle(ctx)) return;
    if (text && await this.agentsCommand.handle(ctx)) return;
    if (text && await this.skillsCommand.handle(ctx)) return;
    if (text && await this.workflowsCommand.handle(ctx)) return;
    if (text && await this.tasksCommand.handle(ctx)) return;

    // Agent channel routing (runtime-backed agents like Sage manage their own working dir)
    if (isAgentChannel(channelId)) {
      const legacyEvent = { user: userId, channel: channelId, thread_ts: threadId, ts: messageId, text };
      const handled = await this.agentHandler.handle(legacyEvent, say);
      if (handled) return;
    }

    // Project resolution replaces the old "working directory" system. In a DM, a leading
    // `project: <name>` line scopes the thread; otherwise mapped channels (or the default
    // "general" workspace) decide where Claude runs.
    const threadKey = `${channelId}:${effectiveThreadId}`;
    let promptText = text || '';
    if (isDM && promptText) {
      const m = promptText.match(/^project:\s*(.+?)\s*(\n[\s\S]*)?$/i);
      if (m) {
        const proj = sanitizeProject(m[1]);
        if (proj) {
          this.threadProjects.set(threadKey, proj);
          promptText = (m[2] || '').trim();
          if (!promptText) {
            await this.transport.send(channelId, effectiveThreadId, `📁 Scoped this thread to *${proj}*.`);
            return;
          }
        }
      } else {
        // No explicit `project:` prefix — auto-scope if a known client name is mentioned.
        // Whole-word match; switches (and announces) only when it differs from the current scope.
        const detected = detectProjectInText(promptText);
        if (detected && this.threadProjects.get(threadKey) !== detected) {
          this.threadProjects.set(threadKey, detected);
          await this.transport.send(channelId, effectiveThreadId, `📁 Working on *${detected}* (say "project: <name>" to switch).`);
        }
      }
    }
    const dmThreadProject = isDM ? this.threadProjects.get(threadKey) : undefined;
    const { dir: workingDirectory, project } = resolveProject(channelId, dmThreadProject);

    // Session management via SessionManager (platform-scoped keys)
    const sessionKey = this.sessionManager.getSessionKey(msg.platform, channelId, threadId, messageId);
    this.originalMessages.set(sessionKey, { channelId, messageId: threadId || messageId });

    const existingController = this.activeControllers.get(sessionKey);
    if (existingController) {
      this.logger.debug('Cancelling existing request for session', { sessionKey });
      existingController.abort();
    }

    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);

    // Use ClaudeHandler sessions (still keyed by userId/channel/thread)
    let session = this.claudeHandler.getSession(userId, channelId, threadId || messageId);
    if (!session) {
      this.logger.debug('Creating new session', { sessionKey });
      session = this.claudeHandler.createSession(userId, channelId, threadId || messageId);
    } else {
      this.logger.debug('Using existing session', { sessionKey, sessionId: session.sessionId });
    }

    let currentMessages = new Set<string>();
    let statusMessageTs: string | undefined;
    let statusLines: string[] = [];
    let claudeSucceeded = false;

    try {
      const basePrompt = processedFiles.length > 0
        ? await this.formatFilePrompt(processedFiles, promptText)
        : promptText;

      // Optional auto-recall: pull relevant long-term memory and inject it ahead of the prompt.
      // No-ops (empty string) when memory is disabled or not installed.
      let memoryPreamble = '';
      if (memoryEnabled() && promptText.trim()) {
        const hits = await recall(promptText);
        memoryPreamble = recallPreamble(hits);
        if (hits.length) this.logger.debug('Injected memory recall', { hits: hits.length });
      }
      const finalPrompt = projectPreamble(project, workingDirectory) + memoryPreamble + basePrompt;

      this.logger.info('Sending query to Claude', {
        prompt: finalPrompt.substring(0, 200) + (finalPrompt.length > 200 ? '...' : ''),
        sessionId: session.sessionId,
        workingDirectory,
        fileCount: processedFiles.length,
      });

      const statusResult = await this.transport.send(channelId, effectiveThreadId, '🤔 *Thinking...*');
      statusMessageTs = statusResult.messageId;

      await this.updateMessageReaction(sessionKey, '🤔');

      const slackContext = { channel: channelId, threadTs: threadId, user: userId };
      const model = this.modelManager.get(channelId, threadId);

      for await (const message of this.claudeHandler.streamQuery(finalPrompt, session, abortController, workingDirectory, slackContext, model)) {
        if (abortController.signal.aborted) break;

        this.logger.debug('Received message from Claude SDK', {
          type: message.type,
          subtype: (message as any).subtype,
        });

        if (message.type === 'assistant') {
          const hasToolUse = message.message.content?.some((part: any) => part.type === 'tool_use');

          if (hasToolUse) {
            await this.updateMessageReaction(sessionKey, '⚙️');

            // Handle TodoWrite specially
            const todoTool = message.message.content?.find((part: any) =>
              part.type === 'tool_use' && part.name === 'TodoWrite'
            );
            if (todoTool) {
              await this.handleTodoUpdate((todoTool as any).input, sessionKey, session?.sessionId, channelId, effectiveThreadId, say);
            }

            // Append tool info to status message
            const toolContent = this.formatToolUseContent(message.message.content);
            if (toolContent && statusMessageTs) {
              statusLines.push(toolContent);
              await this.transport.update(channelId, statusMessageTs, `⚙️ *Working...*\n${statusLines.join('\n')}`);
            }

            // Handle file uploads for Write tool
            for (const part of message.message.content) {
              if ((part as any).type === 'tool_use' && (part as any).name === 'Write') {
                const filePath = ((part as any).input as any).file_path as string;
                if (filePath.endsWith('.html')) {
                  await this.publishHtmlPreview(filePath, channelId, effectiveThreadId, say);
                } else {
                  await this.uploadFileToTransport(filePath, channelId, effectiveThreadId);
                }
              }
            }
          } else {
            const content = this.extractTextContent(message);
            if (content) {
              currentMessages.add(content);
              const sent = await this.transport.send(channelId, effectiveThreadId, this.formatter.formatMessage(content));
              statusMessageTs = sent.messageId;
              statusLines = [];
            }
          }
        } else if (message.type === 'result') {
          this.logger.info('Received result from Claude SDK', {
            subtype: message.subtype,
            totalCost: (message as any).total_cost_usd,
            duration: (message as any).duration_ms,
          });

          if (message.subtype === 'success' && (message as any).result) {
            claudeSucceeded = true;
            const finalResult = (message as any).result as string;
            if (finalResult && !currentMessages.has(finalResult)) {
              const sent = await this.transport.send(channelId, effectiveThreadId, this.formatter.formatMessage(finalResult));
              statusMessageTs = sent.messageId;
              statusLines = [];
            }
          } else if (message.subtype === 'success') {
            claudeSucceeded = true;
          }
        }
      }

      if (claudeSucceeded) await this.transport.send(channelId, effectiveThreadId, '✅ *Task completed*');
      await this.updateMessageReaction(sessionKey, '✅');

      this.logger.info('Completed processing message', { sessionKey, messageCount: currentMessages.size });
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        this.logger.error('Error handling message', error);

        if (statusMessageTs) {
          await this.transport.update(channelId, statusMessageTs, '❌ *Error occurred*');
        }
        await this.updateMessageReaction(sessionKey, '❌');

        await this.transport.send(channelId, effectiveThreadId, '❌ Something went wrong. Please try again.');
      } else {
        this.logger.debug('Request was aborted', { sessionKey });

        if (statusMessageTs) {
          await this.transport.update(channelId, statusMessageTs, '⏹️ *Cancelled*');
        }
        await this.updateMessageReaction(sessionKey, '⏹️');
      }
    } finally {
      this.activeControllers.delete(sessionKey);

      // Cleanup temp files
      for (const file of processedFiles) {
        if (file.tempPath) {
          try { fs.unlinkSync(file.tempPath); } catch { /* ignore */ }
        }
      }

      if (session?.sessionId) {
        setTimeout(() => {
          this.todoManager.cleanupSession(session!.sessionId!);
          this.todoMessages.delete(sessionKey);
          this.originalMessages.delete(sessionKey);
          this.currentReactions.delete(sessionKey);
        }, 5 * 60 * 1000);
      } else {
        this.todoMessages.delete(sessionKey);
        this.originalMessages.delete(sessionKey);
        this.currentReactions.delete(sessionKey);
      }
    }
  }

  private extractTextContent(message: SDKMessage): string | null {
    if (message.type === 'assistant' && message.message.content) {
      const textParts = message.message.content
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text as string);
      return textParts.join('') || null;
    }
    return null;
  }

  private formatToolUseContent(content: any[]): string {
    const parts: string[] = [];

    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text as string);
      } else if (part.type === 'tool_use') {
        const toolName = part.name as string;
        const event = normalizeToolUse(toolName, part.input);
        const formatted = this.formatter.formatToolUse(event);
        if (formatted) {
          parts.push(formatted);
        }
      }
    }

    return parts.filter(Boolean).join('\n\n');
  }

  private async publishHtmlPreview(filePath: string, channelId: string, threadId: string, say: any): Promise<void> {
    try {
      const filename = path.basename(filePath);
      const dest = path.join(HTML_OUTPUTS_DIR, filename);
      fs.copyFileSync(filePath, dest);
      const url = `${PUBLIC_BASE_URL}/previews/${filename}`;
      await say({ text: `🌐 *HTML preview:* ${url}`, thread_ts: threadId });
      this.logger.info('Published HTML preview', { filePath, url });
    } catch (error) {
      this.logger.warn('Failed to publish HTML preview', { filePath, error });
      await this.uploadFileToTransport(filePath, channelId, threadId);
    }
  }

  private async uploadFileToTransport(filePath: string, channelId: string, threadId: string): Promise<void> {
    try {
      const buffer = fs.readFileSync(filePath);
      await this.transport.uploadFile(channelId, threadId, buffer, path.basename(filePath));
      this.logger.info('Uploaded file via transport', { filePath });
    } catch (error) {
      this.logger.warn('Failed to upload file via transport', { filePath, error });
    }
  }

  private async handleTodoUpdate(
    input: any,
    sessionKey: string,
    sessionId: string | undefined,
    channelId: string,
    threadId: string,
    say: (args: { text: string; thread_ts?: string }) => Promise<{ ts: string }>
  ): Promise<void> {
    if (!sessionId || !input.todos) return;

    const newTodos: Todo[] = input.todos as Todo[];
    const oldTodos = this.todoManager.getTodos(sessionId);

    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      this.todoManager.updateTodos(sessionId, newTodos);
      const todoList = this.todoManager.formatTodoList(newTodos);
      const existingTs = this.todoMessages.get(sessionKey);

      if (existingTs) {
        try {
          await this.transport.update(channelId, existingTs, todoList);
          this.logger.debug('Updated existing todo message', { sessionKey, messageTs: existingTs });
        } catch (error) {
          this.logger.warn('Failed to update todo message, creating new one', error);
          const result = await say({ text: todoList, thread_ts: threadId });
          if (result?.ts) {
            this.todoMessages.set(sessionKey, result.ts);
          }
        }
      } else {
        const result = await say({ text: todoList, thread_ts: threadId });
        if (result?.ts) {
          this.todoMessages.set(sessionKey, result.ts);
          this.logger.debug('Created new todo message', { sessionKey, messageTs: result.ts });
        }
      }

      const statusChange = this.todoManager.getStatusChange(oldTodos, newTodos);
      if (statusChange) {
        await say({ text: `🔄 *Task Update:*\n${statusChange}`, thread_ts: threadId });
      }

      await this.updateTaskProgressReaction(sessionKey, newTodos);
    }
  }

  private async updateMessageReaction(sessionKey: string, emoji: string): Promise<void> {
    if (!this.transport.supports('reactions')) return;

    const originalMessage = this.originalMessages.get(sessionKey);
    if (!originalMessage) return;

    const currentEmoji = this.currentReactions.get(sessionKey);
    if (currentEmoji === emoji) return;

    try {
      if (currentEmoji) {
        try {
          await this.transport.removeReaction!(originalMessage.channelId, originalMessage.messageId, currentEmoji);
        } catch {
          // Reaction may not exist
        }
      }

      await this.transport.react!(originalMessage.channelId, originalMessage.messageId, emoji);
      this.currentReactions.set(sessionKey, emoji);
    } catch (error) {
      this.logger.warn('Failed to update message reaction', error);
    }
  }

  private async updateTaskProgressReaction(sessionKey: string, todos: Todo[]): Promise<void> {
    if (todos.length === 0) return;

    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const total = todos.length;

    const emoji =
      completed === total ? '✅' :
      inProgress > 0      ? '🔄' : '📋';

    await this.updateMessageReaction(sessionKey, emoji);
  }

  private async formatFilePrompt(
    files: Array<{ path: string; name: string; mimeType: string; isImage: boolean; isText: boolean; size: number }>,
    userText: string
  ): Promise<string> {
    let prompt = userText || 'Please analyze the uploaded files.';

    if (files.length > 0) {
      prompt += '\n\nUploaded files:\n';

      for (const file of files) {
        if (file.isImage) {
          prompt += `\n## Image: ${file.name}\n`;
          prompt += `File type: ${file.mimeType}\n`;
          prompt += `Path: ${file.path}\n`;
          prompt += `Note: This is an image file that has been uploaded. You can analyze it using the Read tool to examine the image content.\n`;
        } else if (file.isText) {
          prompt += `\n## File: ${file.name}\n`;
          prompt += `File type: ${file.mimeType}\n`;
          try {
            const content = fs.readFileSync(file.path, 'utf-8');
            if (content.length > 10000) {
              prompt += `Content (truncated to first 10000 characters):\n\`\`\`\n${content.substring(0, 10000)}...\n\`\`\`\n`;
            } else {
              prompt += `Content:\n\`\`\`\n${content}\n\`\`\`\n`;
            }
          } catch (error) {
            prompt += `Error reading file content: ${error}\n`;
          }
        } else {
          prompt += `\n## File: ${file.name}\n`;
          prompt += `File type: ${file.mimeType}\n`;
          prompt += `Size: ${file.size} bytes\n`;
          prompt += `Note: This is a binary file. Content analysis may be limited.\n`;
        }
      }

      prompt += '\nPlease analyze these files and provide insights or assistance based on their content.';
    }

    return prompt;
  }
}
