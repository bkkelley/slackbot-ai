import express, { Request, Response, NextFunction } from 'express';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { JobQueue } from './job-queue.js';
import { Scheduler } from './scheduler.js';
import { Executor } from './executor.js';
import { WsManager } from './websocket.js';
import { loadChannels, saveChannels } from './agent-channels.js';
import { AgentJob, AgentJobTemplate, JobEvent } from './types.js';
import { Logger } from './logger.js';
import { createRequire } from 'module';
import { getBudgetPolicyPath, saveBudgetPolicy } from './budgets.js';
import { getNotificationPolicyPath, loadNotificationPolicy, saveNotificationPolicy } from './notifications.js';
import { assemblePrompt } from './context-assembler.js';
import { inspectMnemosyneMemory } from './memory.js';

const logger = new Logger('api');
const require = createRequire(import.meta.url);
const { assertSafeSegment, optionalScope, safeJoin, safeMarkdownFile } = require('../../shared/path-guard.js');
const { resolveActionFilePath } = require('../../shared/action-resolver.js');

const VAULT_PATH = process.env.VAULT_PATH || `${process.env.HOME}/claude-workspaces/admin`;
const BASE_DIRECTORY = process.env.BASE_DIRECTORY || `${process.env.HOME}/claude-workspaces`;
const TOOLSETS_PATH = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'toolsets.json');
const FALLBACK_TOOLSETS: Record<string, string> = {
  'vault-readonly': 'Read,Grep,Glob,PostMessage,WriteCard,GetJobStatus',
  default: 'Read,Grep,Glob,WebSearch,PostMessage,WriteCard,UpdateCard,SpawnAgent,WaitForJob,GetJobStatus,RunSkill,RunWorkflow',
  extended: 'Read,Grep,Glob,WebSearch,Write,Edit,Bash,PostMessage,WriteCard,UpdateCard,SpawnAgent,WaitForJob,GetJobStatus,RunSkill,RunWorkflow',
  web: 'Read,Grep,Glob,WebSearch,WebFetch,PostMessage,WriteCard,GetJobStatus',
  code: 'Read,Grep,Glob,Write,Edit,Bash,PostMessage,WriteCard,GetJobStatus',
};

function optionalSafe(value: unknown, label: string): string | undefined {
  return value ? assertSafeSegment(String(value), label) : undefined;
}

function normalizeJobMode(value: unknown): AgentJob['mode'] {
  if (!value) return 'async';
  if (value === 'sync' || value === 'async' || value === 'preview') return value;
  throw new Error(`Unsupported job mode: ${String(value)}`);
}

function validateScheduleCommand(command: unknown): string | undefined {
  if (!command) return undefined;
  const text = String(command).trim();
  if (!text) return undefined;
  if (/[;&|`$<>]/.test(text)) {
    throw new Error('command contains unsupported shell metacharacters');
  }
  const home = process.env.HOME || '';
  const allowed = [
    `/opt/homebrew/bin/node ${home}/claude-workspaces/system/scheduler/`,
    `/usr/local/bin/node ${home}/claude-workspaces/system/scheduler/`,
    `node ${home}/claude-workspaces/system/scheduler/`,
    `/bin/bash ${home}/claude-workspaces/system/scripts/`,
    `/bin/bash ${home}/claude-workspaces/admin/Meta/`,
  ];
  if (!allowed.some((prefix) => text.startsWith(prefix))) {
    throw new Error('command must use an approved scheduler/script prefix');
  }
  return text;
}

function validateScheduleTemplate(template: Record<string, unknown>): AgentJobTemplate {
  const id = assertSafeSegment(template['id'], 'schedule id');
  const command = validateScheduleCommand(template['command']);
  return {
    ...template,
    id,
    agent: optionalSafe(template['agent'], 'agent name'),
    action: optionalSafe(template['action'], 'action name'),
    workflow: optionalSafe(template['workflow'], 'workflow name'),
    scope: template['scope'] ? optionalScope(template['scope']) : undefined,
    command,
    enabled: template['enabled'] !== false,
  } as AgentJobTemplate;
}

function loadToolsets(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(TOOLSETS_PATH, 'utf8')) as Record<string, string>;
  } catch {
    return FALLBACK_TOOLSETS;
  }
}

function splitToolList(tools: string): string[] {
  return tools.split(',').map((tool) => tool.trim()).filter(Boolean);
}

function readMcpServers(settingsPath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(raw) as Record<string, unknown>;
    if (settings.mcpServers && typeof settings.mcpServers === 'object') {
      return settings.mcpServers as Record<string, unknown>;
    }
  } catch { /* missing or invalid settings are fine for inspection */ }
  return {};
}

function resolveInspectorCwd(job: AgentJob): string {
  const safeScope = optionalScope(job.scope);
  return safeScope ? safeJoin(BASE_DIRECTORY, safeScope) : BASE_DIRECTORY;
}

function resolveInspectorTools(job: AgentJob, cwd: string): {
  requestedToolset: string;
  toolsetExists: boolean;
  baseTools: string[];
  mcpAllowPatterns: string[];
  allowedTools: string[];
  mcpServers: Array<{ name: string; source: 'global' | 'project' }>;
} {
  const toolsets = loadToolsets();
  const requestedToolset = job.toolset ?? 'default';
  const toolsetText = toolsets[requestedToolset] ?? toolsets['default'] ?? FALLBACK_TOOLSETS['default'];
  const globalMcpServers = readMcpServers(path.join(os.homedir(), '.claude', 'settings.json'));
  const projectMcpServers = readMcpServers(path.join(cwd, '.claude', 'settings.json'));
  const mergedMcpServers = { ...globalMcpServers, ...projectMcpServers };
  const baseTools = splitToolList(toolsetText);
  const mcpAllowPatterns = Object.keys(mergedMcpServers).map((name) => `mcp__${name}__*`);
  const globalNames = new Set(Object.keys(globalMcpServers));
  return {
    requestedToolset,
    toolsetExists: Boolean(toolsets[requestedToolset]),
    baseTools,
    mcpAllowPatterns,
    allowedTools: [...baseTools, ...mcpAllowPatterns],
    mcpServers: Object.keys(mergedMcpServers).sort().map((name) => ({
      name,
      source: projectMcpServers[name] ? 'project' : globalNames.has(name) ? 'global' : 'project',
    })),
  };
}

function inspectPromptSources(job: AgentJob): Array<{ label: string; path: string | null; exists: boolean }> {
  const sources: Array<{ label: string; path: string | null; exists: boolean }> = [];
  const safeScope = optionalScope(job.scope);

  if (job.prompt) {
    sources.push({ label: 'Raw prompt', path: null, exists: true });
    return sources;
  }

  if (job.agent) {
    const safeAgent = assertSafeSegment(job.agent, 'agent name');
    const agentCandidates = safeScope
      ? [
          safeMarkdownFile(safeJoin(BASE_DIRECTORY, safeScope, '.claude', 'agents'), safeAgent, 'agent name'),
          safeMarkdownFile(safeJoin(BASE_DIRECTORY, safeScope, '.agents'), safeAgent, 'agent name'),
        ]
      : [
          safeMarkdownFile(safeJoin(process.env.HOME ?? '', '.claude', 'agents'), safeAgent, 'agent name'),
          safeMarkdownFile(safeJoin(BASE_DIRECTORY, '.claude:agents'), safeAgent, 'agent name'),
          safeMarkdownFile(safeJoin(VAULT_PATH, 'Agent'), safeAgent, 'agent name'),
        ];
    const agentPath = agentCandidates.find((candidate) => fs.existsSync(candidate)) ?? agentCandidates[0]!;
    sources.push({ label: 'Agent', path: agentPath, exists: fs.existsSync(agentPath) });

    if (job.action) {
      const safeAction = assertSafeSegment(job.action, 'action name');
      const actionPath = resolveActionFilePath(safeAgent, safeAction, safeScope);
      sources.push({ label: 'Action', path: actionPath, exists: Boolean(actionPath && fs.existsSync(actionPath)) });
    }
  }

  if (job.workflow) {
    const workflowName = assertSafeSegment(job.workflow, 'workflow name');
    const projectPath = safeScope
      ? safeMarkdownFile(safeJoin(BASE_DIRECTORY, safeScope, '.agents', 'workflows'), workflowName, 'workflow name')
      : null;
    const vaultPath = safeMarkdownFile(safeJoin(VAULT_PATH, '_workflows'), workflowName, 'workflow name');
    const workflowPath = projectPath && fs.existsSync(projectPath) ? projectPath : vaultPath;
    sources.push({ label: 'Workflow', path: workflowPath, exists: fs.existsSync(workflowPath) });
  }

  return sources;
}

function inspectFiles(job: AgentJob, cwd: string): Array<{ path: string; resolvedPath: string; exists: boolean; bytes: number | null }> {
  return (job.files ?? []).map((filePath) => {
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    const exists = fs.existsSync(resolvedPath);
    return {
      path: filePath,
      resolvedPath,
      exists,
      bytes: exists ? fs.statSync(resolvedPath).size : null,
    };
  });
}

function durationBetween(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export class ApiServer {
  private app = express();
  private server: http.Server;
  private wss: WebSocketServer;

  constructor(
    private port: number,
    private sharedSecret: string,
    private queue: JobQueue,
    private scheduler: Scheduler,
    private executor: Executor,
    private wsManager: WsManager
  ) {
    this.app.use(express.json());
    this.server = http.createServer(this.app);
    // No path filter — connection handler below checks URL for /api/jobs/:id/stream
    this.wss = new WebSocketServer({ server: this.server });
    this.setupRoutes();
    this.setupWebSocket();
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, '127.0.0.1', () => {
        logger.info('API server started', { port: this.port });
        resolve();
      });
    });
  }

  close(): void {
    this.wss.close();
    this.server.close();
  }

  emitJobEvent(jobId: string, event: JobEvent): void {
    this.wsManager.emit(jobId, event);
  }

  private auth = (req: Request, res: Response, next: NextFunction): void => {
    if (!this.sharedSecret) {
      next();
      return;
    }
    const header = req.headers['x-bot-auth'];
    if (header !== this.sharedSecret) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
    next();
  };

  private setupRoutes(): void {
    // POST /api/jobs — submit job
    this.app.post('/api/jobs', this.auth, async (req: Request, res: Response) => {
      try {
        const body = req.body as Partial<AgentJob>;
        const job = this.queue.enqueue({
          agent: optionalSafe(body.agent, 'agent name'),
          action: optionalSafe(body.action, 'action name'),
          prompt: body.prompt,
          workflow: optionalSafe(body.workflow, 'workflow name'),
          scope: body.scope ? optionalScope(body.scope) : undefined,
          model: body.model,
          mode: normalizeJobMode(body.mode),
          toolset: body.toolset ?? 'default',
          trigger: 'manual',
          outputChannel: body.outputChannel,
          threadId: body.threadId,
          files: body.files,
          replyText: body.replyText,
          workflowContext: body.workflowContext,
          sessionId: body.sessionId,
          parentJobId: body.parentJobId,
        });

        if (body.mode === 'sync') {
          const result = await this.queue.waitForJob(job.id, 5 * 60 * 1000);
          res.json({ jobId: job.id, status: 'done', result });
          return;
        }

        res.json({ jobId: job.id, status: 'pending' });
      } catch (err) {
        res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/jobs/stats?window=today|7d|30d|all
    this.app.get('/api/jobs/stats', this.auth, (req: Request, res: Response) => {
      const window = req.query['window'] as string | undefined;
      let since: string | undefined;
      if (window === 'today') {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        since = d.toISOString();
      } else if (window === '7d') {
        since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      } else if (window === '30d') {
        since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      }
      const stats = this.queue.getAgentStats(since);
      res.json({ stats, window: window || 'all' });
    });

    // GET /api/budgets — daily budget policy and current usage
    this.app.get('/api/budgets', this.auth, (_req: Request, res: Response) => {
      res.json({
        ...this.queue.getBudgetStatus(),
        path: getBudgetPolicyPath(),
      });
    });

    // PUT /api/budgets — update daily budget policy
    this.app.put('/api/budgets', this.auth, (req: Request, res: Response) => {
      const policy = req.body?.policy ?? req.body;
      if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
        res.status(400).json({ error: 'Expected budget policy object' });
        return;
      }
      try {
        saveBudgetPolicy(policy);
        res.json({
          ...this.queue.getBudgetStatus(),
          path: getBudgetPolicyPath(),
        });
      } catch (err) {
        res.status(500).json({ error: `Failed to save budget policy: ${err instanceof Error ? err.message : String(err)}` });
      }
    });

    // GET /api/notifications — notification policy
    this.app.get('/api/notifications', this.auth, (_req: Request, res: Response) => {
      const policy = loadNotificationPolicy();
      res.json({
        enabled: policy.enabled !== false,
        policy,
        path: getNotificationPolicyPath(),
      });
    });

    // PUT /api/notifications — update notification policy
    this.app.put('/api/notifications', this.auth, (req: Request, res: Response) => {
      const policy = req.body?.policy ?? req.body;
      if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
        res.status(400).json({ error: 'Expected notification policy object' });
        return;
      }
      try {
        saveNotificationPolicy(policy);
        const saved = loadNotificationPolicy();
        res.json({
          enabled: saved.enabled !== false,
          policy: saved,
          path: getNotificationPolicyPath(),
        });
      } catch (err) {
        res.status(500).json({ error: `Failed to save notification policy: ${err instanceof Error ? err.message : String(err)}` });
      }
    });

    // GET /api/jobs
    this.app.get('/api/jobs', this.auth, (req: Request, res: Response) => {
      const status = req.query['status'] as string | undefined;
      const parentJobId = req.query['parentJobId'] as string | undefined;
      const limit = req.query['limit'] ? parseInt(req.query['limit'] as string, 10) : 50;
      const offset = req.query['offset'] ? parseInt(req.query['offset'] as string, 10) : 0;
      const jobs = this.queue.listJobs({ status, parentJobId, limit, offset });
      res.json({ jobs });
    });

    // GET /api/jobs/:id/debug — read-only prompt/session diagnostics for the management UI
    this.app.get('/api/jobs/:id/debug', this.auth, async (req: Request, res: Response) => {
      const job = this.queue.getJob(req.params['id']!);
      if (!job) {
        res.status(404).json({ ok: false, error: 'Not found' });
        return;
      }

      const priorSessionJobs = job.sessionId
        ? this.queue.getSessionJobs(job.sessionId).filter((sessionJob) => sessionJob.id !== job.id)
        : [];
      const sessionHistory = priorSessionJobs.flatMap((sessionJob) => {
        const entries: Array<{ jobId: string; role: string; text: string }> = [];
        if (sessionJob.replyText) entries.push({ jobId: sessionJob.id, role: 'user', text: sessionJob.replyText });
        if (sessionJob.result?.textOutput) entries.push({ jobId: sessionJob.id, role: 'sage', text: sessionJob.result.textOutput });
        return entries;
      });

      let promptPreview: string | undefined;
      let promptError: string | undefined;
      if (job.agent || job.prompt) {
        try {
          promptPreview = await assemblePrompt(job, { sessionHistory });
        } catch (err) {
          promptError = err instanceof Error ? err.message : String(err);
        }
      }

      let cwd = BASE_DIRECTORY;
      let cwdExists = false;
      try {
        cwd = resolveInspectorCwd(job);
        cwdExists = fs.existsSync(cwd);
      } catch {
        cwdExists = false;
      }
      const tools = resolveInspectorTools(job, cwd);
      const childJobs = this.queue.listJobs({ parentJobId: job.id, limit: 120 });
      const approvals = this.queue.listApprovals({ limit: 500 }).filter((approval) => approval.workflowJobId === job.id);
      const promptSources = inspectPromptSources(job);
      const files = inspectFiles(job, cwd);
      const memory = inspectMnemosyneMemory(job);
      const result = job.result;
      const resultCounts = {
        cards: result?.cardFiles?.length ?? 0,
        childJobs: result?.childJobIds?.length ?? childJobs.length,
        messages: result?.postedMessageIds?.length ?? 0,
        approvals: result?.approvalIds?.length ?? approvals.length,
      };
      const timing = {
        queuedMs: durationBetween(job.createdAt, job.startedAt),
        runtimeMs: result?.durationMs ?? durationBetween(job.startedAt, job.completedAt),
        apiMs: result?.apiDurationMs ?? null,
        totalMs: durationBetween(job.createdAt, job.completedAt),
      };
      const sessionJobs = job.sessionId ? this.queue.getSessionJobs(job.sessionId) : [];

      res.json({
        jobId: job.id,
        kind: job.workflow ? 'workflow' : job.agent ? 'agent' : job.prompt ? 'prompt' : 'job',
        promptPreview,
        promptError,
        promptChars: promptPreview?.length ?? 0,
        sessionHistory,
        sessionTurnCount: sessionHistory.length,
        inspector: {
          identity: {
            id: job.id,
            kind: job.workflow ? 'workflow' : job.agent ? 'agent' : job.prompt ? 'prompt' : 'job',
            status: job.status,
            trigger: job.trigger,
            mode: job.mode,
            parentJobId: job.parentJobId ?? null,
          },
          request: {
            agent: job.agent ?? null,
            action: job.action ?? null,
            workflow: job.workflow ?? null,
            scope: job.scope ?? null,
            model: result?.model ?? job.model ?? null,
            toolset: job.toolset ?? 'default',
            sessionId: job.sessionId ?? null,
            threadId: job.threadId ?? null,
            replyTextChars: job.replyText?.length ?? 0,
            workflowContextChars: job.workflowContext?.length ?? 0,
          },
          timing,
          routing: {
            outputChannel: job.outputChannel ?? null,
            threadId: job.threadId ?? null,
            postedMessageIds: result?.postedMessageIds ?? [],
          },
          workspace: {
            cwd,
            exists: cwdExists,
          },
          prompt: {
            chars: promptPreview?.length ?? 0,
            error: promptError ?? null,
            sources: promptSources,
          },
          memory,
          files,
          tools: {
            requestedToolset: tools.requestedToolset,
            toolsetExists: tools.toolsetExists,
            baseTools: tools.baseTools,
            mcpAllowPatterns: tools.mcpAllowPatterns,
            allowedTools: tools.allowedTools,
            mcpServers: tools.mcpServers,
            used: result?.toolsUsed ?? [],
            unusedAllowed: result?.unusedAllowedTools ?? [],
            callCount: result?.toolCallCount ?? 0,
          },
          result: {
            ok: result?.ok ?? null,
            error: result?.error ?? null,
            counts: resultCounts,
            costUsd: result?.totalCostUsd ?? null,
            totalTokens: result?.totalTokens ?? null,
            outputChars: result?.outputChars ?? result?.textOutput?.length ?? 0,
            efficiencyHints: result?.efficiencyHints ?? [],
          },
          children: childJobs.map((child) => ({
            id: child.id,
            status: child.status,
            kind: child.workflow ? 'workflow' : child.agent ? 'agent' : child.prompt ? 'prompt' : 'job',
            title: child.agent ? `${child.agent}${child.action ? ` / ${child.action}` : ''}` : child.workflow ?? child.id,
            createdAt: child.createdAt,
            completedAt: child.completedAt,
            ok: child.result?.ok ?? null,
            error: child.result?.error ?? null,
            costUsd: child.result?.totalCostUsd ?? null,
          })),
          approvals: approvals.map((approval) => ({
            id: approval.id,
            stepIndex: approval.stepIndex,
            status: approval.status,
            prompt: approval.prompt,
            createdAt: approval.createdAt,
            resolvedAt: approval.resolvedAt,
            resolvedBy: approval.resolvedBy,
          })),
          session: {
            id: job.sessionId ?? null,
            jobs: sessionJobs.map((sessionJob) => ({
              id: sessionJob.id,
              status: sessionJob.status,
              createdAt: sessionJob.createdAt,
              agent: sessionJob.agent,
              action: sessionJob.action,
              outputChars: sessionJob.result?.outputChars ?? sessionJob.result?.textOutput?.length ?? 0,
            })),
            turns: sessionHistory,
          },
        },
      });
    });

    // GET /api/jobs/:id
    this.app.get('/api/jobs/:id', this.auth, (req: Request, res: Response) => {
      const job = this.queue.getJob(req.params['id']!);
      if (!job) {
        res.status(404).json({ ok: false, error: 'Not found' });
        return;
      }
      res.json(job);
    });

    // DELETE /api/jobs/:id
    this.app.delete('/api/jobs/:id', this.auth, (req: Request, res: Response) => {
      const job = this.queue.getJob(req.params['id']!);
      if (!job) {
        res.status(404).json({ ok: false, error: 'Not found' });
        return;
      }
      if (job.status === 'pending' || job.status === 'running') {
        this.queue.updateStatus(job.id, 'failed', {
          completedAt: new Date().toISOString(),
          result: {
            ok: false,
            error: 'Cancelled',
            postedMessageIds: [],
            cardFiles: [],
            childJobIds: [],
          },
        });
      }
      res.json({ ok: true });
    });

    // GET /api/approvals
    this.app.get('/api/approvals', this.auth, (req: Request, res: Response) => {
      const status = req.query['status'] as 'pending' | 'approved' | 'denied' | 'timed_out' | undefined;
      const limit = req.query['limit'] ? parseInt(req.query['limit'] as string, 10) : 50;
      res.json({ approvals: this.queue.listApprovals({ status, limit }) });
    });

    // GET /api/approvals/:id
    this.app.get('/api/approvals/:id', this.auth, (req: Request, res: Response) => {
      const approval = this.queue.getApproval(req.params['id']!);
      if (!approval) {
        res.status(404).json({ ok: false, error: 'Not found' });
        return;
      }
      res.json(approval);
    });

    // POST /api/approvals/:id/approve
    this.app.post('/api/approvals/:id/approve', this.auth, (req: Request, res: Response) => {
      const body = req.body as { resolvedBy?: string; comment?: string };
      const approval = this.queue.resolveApproval(req.params['id']!, 'approved', body);
      if (!approval) {
        res.status(404).json({ ok: false, error: 'Not found' });
        return;
      }
      res.json({ ok: true, approval });
    });

    // POST /api/approvals/:id/deny
    this.app.post('/api/approvals/:id/deny', this.auth, (req: Request, res: Response) => {
      const body = req.body as { resolvedBy?: string; comment?: string };
      const approval = this.queue.resolveApproval(req.params['id']!, 'denied', body);
      if (!approval) {
        res.status(404).json({ ok: false, error: 'Not found' });
        return;
      }
      res.json({ ok: true, approval });
    });

    // POST /api/agents/:name/run — shorthand
    this.app.post(
      '/api/agents/:name/run',
      this.auth,
      async (req: Request, res: Response) => {
        try {
          const body = req.body as Partial<AgentJob>;
          const job = this.queue.enqueue({
            agent: assertSafeSegment(req.params['name']!, 'agent name'),
            action: optionalSafe(body.action, 'action name'),
            prompt: body.prompt,
            model: body.model,
            mode: normalizeJobMode(body.mode),
            toolset: body.toolset ?? 'default',
            trigger: 'manual',
            outputChannel: body.outputChannel,
            threadId: body.threadId,
            files: body.files,
            replyText: body.replyText,
            sessionId: body.sessionId,
          });

          if (body.mode === 'sync') {
            const result = await this.queue.waitForJob(job.id, 5 * 60 * 1000);
            res.json({ jobId: job.id, status: 'done', result });
            return;
          }

          res.json({ jobId: job.id, status: 'pending' });
        } catch (err) {
          res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
    );

    // POST /api/workflows/:name/run — shorthand for workflow jobs
    this.app.post(
      '/api/workflows/:name/run',
      this.auth,
      async (req: Request, res: Response) => {
        try {
          const body = req.body as Partial<AgentJob>;
          const job = this.queue.enqueue({
            workflow: assertSafeSegment(req.params['name']!, 'workflow name'),
            scope: body.scope ? optionalScope(body.scope) : undefined,
            model: body.model,
            mode: normalizeJobMode(body.mode),
            toolset: body.toolset ?? 'default',
            trigger: 'manual',
            outputChannel: body.outputChannel,
            threadId: body.threadId,
            files: body.files,
            replyText: body.replyText,
            workflowContext: body.workflowContext,
          });

          if (body.mode === 'sync') {
            const result = await this.queue.waitForJob(job.id, 10 * 60 * 1000);
            res.json({ jobId: job.id, status: 'done', result });
            return;
          }

          res.json({ jobId: job.id, status: 'pending' });
        } catch (err) {
          res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
    );

    // GET /api/schedules
    this.app.get('/api/schedules', this.auth, (_req: Request, res: Response) => {
      res.json({ schedules: this.scheduler.getTemplates() });
    });

    // POST /api/schedules
    this.app.post('/api/schedules', this.auth, (req: Request, res: Response) => {
      let template: AgentJobTemplate;
      try {
        template = validateScheduleTemplate(req.body);
      } catch (err) {
        res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      this.scheduler.upsertTemplate(template);
      res.json({ ok: true });
    });

    // DELETE /api/schedules/:id
    this.app.delete(
      '/api/schedules/:id',
      this.auth,
      (req: Request, res: Response) => {
        this.scheduler.deleteTemplate(assertSafeSegment(req.params['id']!, 'schedule id'));
        res.json({ ok: true });
      }
    );

    // GET /api/channels
    this.app.get('/api/channels', this.auth, (_req: Request, res: Response) => {
      res.json(loadChannels());
    });

    // PUT /api/channels/:platform/:channelId
    this.app.put(
      '/api/channels/:platform/:channelId',
      this.auth,
      (req: Request, res: Response) => {
        const key = `${assertSafeSegment(req.params['platform'], 'platform')}:${assertSafeSegment(req.params['channelId'], 'channel id')}`;
        const { agent } = req.body as { agent: string };
        if (!agent) {
          res.status(400).json({ ok: false, error: 'agent is required' });
          return;
        }
        const channels = loadChannels();
        channels[key] = { agent: assertSafeSegment(agent, 'agent name') };
        saveChannels(channels);
        res.json({ ok: true });
      }
    );

    // DELETE /api/channels/:platform/:channelId
    this.app.delete(
      '/api/channels/:platform/:channelId',
      this.auth,
      (req: Request, res: Response) => {
        const key = `${assertSafeSegment(req.params['platform'], 'platform')}:${assertSafeSegment(req.params['channelId'], 'channel id')}`;
        const channels = loadChannels();
        delete channels[key];
        saveChannels(channels);
        res.json({ ok: true });
      }
    );
  }

  private setupWebSocket(): void {
    // WebSocket upgrade is for paths matching /api/jobs/:id/stream
    this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
      const url = req.url ?? '';
      const match = url.match(/^\/api\/jobs\/([^/]+)\/stream/);
      if (!match) {
        ws.close(1008, 'Invalid path');
        return;
      }
      if (this.sharedSecret && req.headers['x-bot-auth'] !== this.sharedSecret) {
        ws.close(1008, 'Unauthorized');
        return;
      }
      const jobId = match[1]!;
      const job = this.queue.getJob(jobId);

      // Send current status on connect
      if (job) {
        if (job.status === 'done' || job.status === 'failed') {
          // Only send terminal status — pending/running just subscribe and wait
          const statusEvent: JobEvent = {
            type: 'status',
            status: job.status,
            result: job.result,
          };
          ws.send(JSON.stringify(statusEvent));
        }
        // pending/running: subscribe and wait for real events
      }

      this.wsManager.subscribe(jobId, ws);
      logger.debug('WS client connected', { jobId });
    });
  }
}
