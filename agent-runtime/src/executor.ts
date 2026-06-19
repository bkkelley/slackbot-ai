import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentJob, EfficiencyHint, JobEvent, JobPreview, JobResult } from './types.js';
import { JobQueue } from './job-queue.js';
import { assemblePrompt } from './context-assembler.js';
import { previewWorkflow, runWorkflow } from './workflow-executor.js';
import { postMessage } from './mcp/tools/post-message.js';
import { Logger } from './logger.js';
import { createRequire } from 'module';

const logger = new Logger('executor');
const require = createRequire(import.meta.url);
const { optionalScope, safeJoin } = require('../../shared/path-guard.js');

const CLAUDE_PATH = process.env.CLAUDE_PATH || `${process.env.HOME}/.local/bin/claude`;
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || '3', 10);
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || String(60 * 60 * 1000), 10);
const JOB_TIMEOUT_KILL_GRACE_MS = parseInt(process.env.JOB_TIMEOUT_KILL_GRACE_MS || String(10 * 1000), 10);
const MCP_SERVER_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  'mcp',
  'server.ts'
);

const TOOLSETS_PATH = path.join(
  path.dirname(path.dirname(new URL(import.meta.url).pathname)),
  'toolsets.json'
);

const FALLBACK_TOOLSETS: Record<string, string> = {
  'vault-readonly': 'Read,Grep,Glob,PostMessage,GetJobStatus',
  'default': 'Read,Grep,Glob,WebSearch,PostMessage,SpawnAgent,WaitForJob,GetJobStatus,RunSkill,RunWorkflow,WriteCanvas,ScheduleMessage,ListScheduledMessages,CancelScheduledMessage,AddReminder,CreateTaskList,AddTask,ListTasks',
  'extended': 'Read,Grep,Glob,WebSearch,Write,Edit,Bash,PostMessage,SpawnAgent,WaitForJob,GetJobStatus,RunSkill,RunWorkflow,WriteCanvas,ScheduleMessage,ListScheduledMessages,CancelScheduledMessage,AddReminder,CreateTaskList,AddTask,ListTasks',
  'web': 'Read,Grep,Glob,WebSearch,WebFetch,PostMessage,GetJobStatus',
  'code': 'Read,Grep,Glob,Write,Edit,Bash,PostMessage,GetJobStatus',
};

function loadToolsets(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(TOOLSETS_PATH, 'utf8')) as Record<string, string>;
  } catch {
    return FALLBACK_TOOLSETS;
  }
}

function resolveToolset(toolset: string | undefined): string {
  const toolsets = loadToolsets();
  return toolsets[toolset ?? 'default'] ?? toolsets['default'] ?? FALLBACK_TOOLSETS['default'];
}

function resolveToolsetForPreview(toolset: string | undefined): { name: string; exists: boolean; tools: string } {
  const toolsets = loadToolsets();
  const requested = toolset ?? 'default';
  return {
    name: requested,
    exists: Boolean(toolsets[requested]),
    tools: toolsets[requested] ?? toolsets['default'] ?? FALLBACK_TOOLSETS['default'],
  };
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
  } catch { /* missing or unparseable — fine */ }
  return {};
}

function validateOutputChannel(outputChannel: AgentJob['outputChannel']): string[] {
  if (!outputChannel) return [];
  const errors: string[] = [];
  if (!outputChannel.platform || typeof outputChannel.platform !== 'string') {
    errors.push('Output channel platform is required.');
  }
  if (!outputChannel.id || typeof outputChannel.id !== 'string') {
    errors.push('Output channel id is required.');
  }
  return errors;
}

export class Executor {
  private _runningCount = 0;
  private _ipcPort: number = 0;

  setIpcPort(port: number): void {
    this._ipcPort = port;
  }

  get availableSlots(): number {
    return MAX_CONCURRENT_JOBS - this._runningCount;
  }

  get isAtCapacity(): boolean {
    return this._runningCount >= MAX_CONCURRENT_JOBS;
  }

  async runJob(
    job: AgentJob,
    queue: JobQueue,
    wsEmitter: (jobId: string, event: JobEvent) => void
  ): Promise<void> {
    this._runningCount++;
    try {
      await this._execute(job, queue, wsEmitter);
    } finally {
      this._runningCount--;
    }
  }

  // Run a child job inline (sync SpawnAgent) — does NOT occupy a new worker slot
  // because the caller's slot is already occupied
  async runInline(
    childJob: AgentJob,
    parentJobId: string,
    queue: JobQueue,
    wsEmitter: (jobId: string, event: JobEvent) => void
  ): Promise<JobResult> {
    queue.removePending(childJob.id);
    logger.info('Running inline child job', {
      childJobId: childJob.id,
      parentJobId,
    });
    await this._execute(childJob, queue, wsEmitter);
    const completed = queue.getJob(childJob.id);
    return (
      completed?.result ?? {
        ok: false,
        error: 'inline job produced no result',
        postedMessageIds: [],
        cardFiles: [],
        childJobIds: [],
      }
    );
  }

  private async _execute(
    job: AgentJob,
    queue: JobQueue,
    wsEmitter: (jobId: string, event: JobEvent) => void
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    queue.updateStatus(job.id, 'running', { startedAt });
    wsEmitter(job.id, { type: 'status', status: 'running' });

    if (job.mode === 'preview') {
      const preview = job.workflow
        ? await previewWorkflow(job, (childJob) => this.previewAgentJob(childJob, queue))
        : await this.previewAgentJob(job, queue);
      const completedAt = new Date().toISOString();
      const result: JobResult = {
        ok: preview.ok,
        error: preview.errors.join('\n') || undefined,
        postedMessageIds: [],
        cardFiles: [],
        childJobIds: [],
        textOutput: formatPreviewText(preview),
        durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
        outputChars: preview.promptChars ?? preview.workflow?.steps.reduce((sum, step) => sum + (step.promptChars ?? 0), 0) ?? 0,
        preview,
      };
      const status = preview.ok ? 'done' : 'failed';
      queue.updateStatus(job.id, status, { completedAt, result });
      wsEmitter(job.id, { type: 'status', status, result });
      wsEmitter(job.id, { type: 'done', status, result });
      return;
    }

    // Workflow jobs — delegate to workflow-executor, no Claude spawn needed
    if (job.workflow) {
      const inlineRunner = (childJob: AgentJob, parentJobId: string) =>
        this.runInline(childJob, parentJobId, queue, wsEmitter);
      const result = await runWorkflow(job, queue, inlineRunner);
      const status = result.ok ? 'done' : 'failed';
      const completedAt = new Date().toISOString();
      result.durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
      result.efficiencyHints = buildEfficiencyHints(result, job.toolset, splitToolList(resolveToolset(job.toolset)));
      queue.updateStatus(job.id, status, {
        completedAt,
        result,
      });
      wsEmitter(job.id, { type: 'done', status, result });
      return;
    }

    // Pre-fetch session history from SQLite before prompt assembly
    let sessionHistory: Array<{ role: string; text: string }> | undefined;
    if (job.sessionId) {
      const prevJobs = queue.getSessionJobs(job.sessionId);
      sessionHistory = prevJobs.flatMap((j) => {
        const entries: Array<{ role: string; text: string }> = [];
        if (j.replyText) entries.push({ role: 'user', text: j.replyText });
        if (j.result?.textOutput) entries.push({ role: 'sage', text: j.result.textOutput });
        return entries;
      });
    }

    let prompt: string;
    try {
      prompt = await assemblePrompt(job, { sessionHistory });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Prompt assembly failed', { jobId: job.id, error });
      const result: JobResult = {
        ok: false,
        error,
        postedMessageIds: [],
        cardFiles: [],
        childJobIds: [],
      };
      queue.updateStatus(job.id, 'failed', {
        completedAt: new Date().toISOString(),
        result,
      });
      wsEmitter(job.id, { type: 'done', status: 'failed', result });
      return;
    }

    const BASE_DIRECTORY = process.env.BASE_DIRECTORY || `${process.env.HOME}/claude-workspaces`;
    const safeScope = optionalScope(job.scope);
    const cwd = safeScope
      ? safeJoin(BASE_DIRECTORY, safeScope)
      : BASE_DIRECTORY;

    // Read global then project .claude/settings.json — project wins on conflict
    function readMcpServers(settingsPath: string): Record<string, unknown> {
      try {
        const raw = fs.readFileSync(settingsPath, 'utf8');
        const settings = JSON.parse(raw) as Record<string, unknown>;
        if (settings.mcpServers && typeof settings.mcpServers === 'object') {
          return settings.mcpServers as Record<string, unknown>;
        }
      } catch { /* missing or unparseable — fine */ }
      return {};
    }

    const globalMcpServers = readMcpServers(path.join(os.homedir(), '.claude', 'settings.json'));
    const projectMcpServers = readMcpServers(path.join(cwd, '.claude', 'settings.json'));
    const extraMcpServers = { ...globalMcpServers, ...projectMcpServers };

    // Write MCP config to temp file, merging global + project servers
    const mcpConfigPath = path.join(os.tmpdir(), `mcp-${job.id}.json`);
    const mcpConfig = {
      mcpServers: {
        'agent-tools': {
          command: 'npx',
          args: ['tsx', MCP_SERVER_PATH],
          env: {
            RUNTIME_IPC_PORT: String(this._ipcPort),
            JOB_ID: job.id,
            VAULT_PATH: process.env.VAULT_PATH || `${process.env.HOME}/claude-workspaces/global`,
            BOT_HTTP_PORT: process.env.BOT_HTTP_PORT || '3458',
            BOT_RUNTIME_SHARED_SECRET: process.env.BOT_RUNTIME_SHARED_SECRET || '',
          },
        },
        ...extraMcpServers,
      },
    };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // Append mcp__<serverName>__* allow patterns for all extra MCP servers
    const extraMcpAllowPatterns = Object.keys(extraMcpServers)
      .map((name) => `mcp__${name}__*`)
      .join(',');
    const baseAllowedTools = resolveToolset(job.toolset);
    const allowedTools = extraMcpAllowPatterns
      ? `${baseAllowedTools},${extraMcpAllowPatterns}`
      : baseAllowedTools;

    if (Object.keys(extraMcpServers).length > 0) {
      logger.info('Loaded MCP servers', {
        jobId: job.id,
        global: Object.keys(globalMcpServers),
        project: Object.keys(projectMcpServers),
      });
    }

    const args = [
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--permission-mode',
      'bypassPermissions',
      '--allowed-tools',
      allowedTools,
      '--mcp-config',
      mcpConfigPath,
    ];
    if (job.model) {
      args.push('--model', job.model);
    }

    logger.info('Spawning Claude', {
      jobId: job.id,
      agent: job.agent,
      action: job.action,
      model: job.model,
      promptLength: prompt.length,
    });

    const child = spawn(CLAUDE_PATH, args, {
      env: { ...process.env },
      cwd,
    });

    child.stdin.write(prompt);
    child.stdin.end();

    const postedMessageIds: string[] = [];
    const cardFiles: string[] = [];
    const childJobIds: string[] = [];
    const textChunks: string[] = [];
    const toolCounts = new Map<string, number>();
    let claudeResult: Record<string, unknown> | null = null;

    child.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg['type'] === 'result') {
            claudeResult = msg;
          }
          for (const toolName of extractToolNames(msg)) {
            toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
          }
          const event = parseClaudeEvent(msg);
          if (event) {
            if (event.type === 'text' && event.text) textChunks.push(event.text);
            if (event.type === 'tool' && event.tool === 'PostMessage') {
              const text = readString(asRecord(event.input), ['text']);
              if (text) textChunks.push(text);
            }
            wsEmitter(job.id, event);
          }
        } catch {
          // Not JSON — pass through as text event
          wsEmitter(job.id, { type: 'text', text: line });
        }
      }
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    await new Promise<void>((resolve) => {
      let timedOut = false;
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | null = null;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        logger.warn('Job timed out; terminating Claude process', {
          jobId: job.id,
          timeoutMs: JOB_TIMEOUT_MS,
        });
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => {
          if (!settled) {
            logger.warn('Claude process did not exit after timeout; force killing', {
              jobId: job.id,
              graceMs: JOB_TIMEOUT_KILL_GRACE_MS,
            });
            child.kill('SIGKILL');
          }
        }, JOB_TIMEOUT_KILL_GRACE_MS);
      }, JOB_TIMEOUT_MS);

      child.on('close', (code) => {
        settled = true;
        clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        // Cleanup temp file
        try {
          fs.unlinkSync(mcpConfigPath);
        } catch {}

        // Get accumulated results from queue (set by IPC server as tools fire)
        const updatedJob = queue.getJob(job.id);
        const accumulated = updatedJob?.result ?? {
          ok: true,
          postedMessageIds: [],
          cardFiles: [],
          childJobIds: [],
        };
        const completedAt = new Date().toISOString();
        const usage = extractUsageMetrics(claudeResult);
        const toolsUsed = Array.from(toolCounts.keys()).sort();
        const allowedToolList = splitToolList(allowedTools);
        const textOutput = textChunks.length > 0 ? textChunks.join('') : undefined;

        const result: JobResult = {
          ok: !timedOut && code === 0,
          error: timedOut
            ? `Claude timed out after ${Math.round(JOB_TIMEOUT_MS / 60000)} minutes`
            : code !== 0 ? `Claude exited ${code}: ${stderr.slice(0, 500)}` : undefined,
          postedMessageIds: accumulated.postedMessageIds ?? postedMessageIds,
          cardFiles: accumulated.cardFiles ?? cardFiles,
          childJobIds: accumulated.childJobIds ?? childJobIds,
          textOutput,
          durationMs: usage.durationMs ?? (new Date(completedAt).getTime() - new Date(startedAt).getTime()),
          apiDurationMs: usage.apiDurationMs,
          totalCostUsd: usage.totalCostUsd,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          totalTokens: usage.totalTokens,
          model: usage.model,
          toolCallCount: Array.from(toolCounts.values()).reduce((sum, count) => sum + count, 0),
          toolsUsed,
          unusedAllowedTools: allowedToolList.filter((tool) => !toolsUsed.includes(tool) && !tool.includes('*')),
          outputChars: textOutput?.length ?? 0,
        };
        result.efficiencyHints = buildEfficiencyHints(result, job.toolset, allowedToolList);

        const status = !timedOut && code === 0 ? 'done' : 'failed';
        queue.updateStatus(job.id, status, {
          completedAt,
          result,
        });
        wsEmitter(job.id, { type: 'done', status, result });

        if (timedOut) {
          logger.error('Claude timed out', {
            jobId: job.id,
            timeoutMs: JOB_TIMEOUT_MS,
          });
          notifyJobFailure(job, result).catch((err) => {
            logger.warn('Failed to send timeout notification', {
              jobId: job.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        } else if (code !== 0) {
          logger.error('Claude exited with error', {
            jobId: job.id,
            code,
            stderr: stderr.slice(0, 500),
          });
          notifyJobFailure(job, result).catch((err) => {
            logger.warn('Failed to send failure notification', {
              jobId: job.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        } else {
          logger.info('Job completed', {
            jobId: job.id,
            postedMessages: result.postedMessageIds.length,
            cards: result.cardFiles.length,
            children: result.childJobIds.length,
            totalCostUsd: result.totalCostUsd,
            durationMs: result.durationMs,
            toolCallCount: result.toolCallCount,
          });
        }

        resolve();
      });

      child.on('error', (err) => {
        settled = true;
        clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        try {
          fs.unlinkSync(mcpConfigPath);
        } catch {}
        const result: JobResult = {
          ok: false,
          error: err.message,
          postedMessageIds: [],
          cardFiles: [],
          childJobIds: [],
        };
        queue.updateStatus(job.id, 'failed', {
          completedAt: new Date().toISOString(),
          result,
        });
        wsEmitter(job.id, { type: 'done', status: 'failed', result });
        logger.error('Spawn error', { jobId: job.id, error: err.message });
        resolve();
      });
    });
  }

  private async previewAgentJob(job: AgentJob, queue: JobQueue): Promise<JobPreview> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const BASE_DIRECTORY = process.env.BASE_DIRECTORY || `${process.env.HOME}/claude-workspaces`;
    let cwd = BASE_DIRECTORY;

    try {
      const safeScope = optionalScope(job.scope);
      cwd = safeScope ? safeJoin(BASE_DIRECTORY, safeScope) : BASE_DIRECTORY;
      if (!fs.existsSync(cwd)) errors.push(`Working directory not found: ${cwd}`);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    const toolset = resolveToolsetForPreview(job.toolset);
    if (!toolset.exists) {
      errors.push(`Unknown toolset "${toolset.name}"; runtime would fall back to default.`);
    }

    const globalMcpServers = readMcpServers(path.join(os.homedir(), '.claude', 'settings.json'));
    const projectMcpServers = readMcpServers(path.join(cwd, '.claude', 'settings.json'));
    const extraMcpAllowPatterns = Object.keys({ ...globalMcpServers, ...projectMcpServers })
      .map((name) => `mcp__${name}__*`);
    const allowedTools = [...splitToolList(toolset.tools), ...extraMcpAllowPatterns];

    errors.push(...validateOutputChannel(job.outputChannel));

    const files = (job.files ?? []).map((filePath) => {
      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
      const exists = fs.existsSync(resolvedPath);
      if (!exists) errors.push(`File not found: ${filePath}`);
      return { path: filePath, resolvedPath, exists };
    });

    let sessionHistory: Array<{ role: string; text: string }> | undefined;
    if (job.sessionId) {
      const prevJobs = queue.getSessionJobs(job.sessionId);
      sessionHistory = prevJobs.flatMap((j) => {
        const entries: Array<{ role: string; text: string }> = [];
        if (j.replyText) entries.push({ role: 'user', text: j.replyText });
        if (j.result?.textOutput) entries.push({ role: 'sage', text: j.result.textOutput });
        return entries;
      });
    }

    let promptPreview: string | undefined;
    try {
      promptPreview = await assemblePrompt(job, { sessionHistory });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    return {
      kind: job.agent ? 'agent' : job.prompt ? 'prompt' : 'job',
      ok: errors.length === 0,
      errors,
      warnings,
      promptPreview,
      promptChars: promptPreview?.length ?? 0,
      cwd,
      toolset: toolset.name,
      allowedTools,
      outputChannel: job.outputChannel,
      files,
    };
  }
}

async function notifyJobFailure(job: AgentJob, result: JobResult): Promise<void> {
  if (!job.outputChannel) return;
  const title = job.agent
    ? `${job.agent}${job.action ? ` / ${job.action}` : ''}`
    : job.workflow ? `workflow ${job.workflow}` : 'runtime job';
  await postMessage(
    {
      text: `Job failed: ${title}\nJob ID: ${job.id}\nError: ${result.error ?? 'Unknown error'}`,
      notificationKind: 'failure',
    },
    {
      jobOutputChannel: job.outputChannel,
      jobThreadId: job.threadId,
      job,
    }
  );
}

function formatPreviewText(preview: JobPreview): string {
  const lines = [
    preview.ok ? 'Preview passed.' : 'Preview failed.',
    `Kind: ${preview.kind}`,
  ];
  if (preview.promptChars !== undefined) lines.push(`Prompt chars: ${preview.promptChars}`);
  if (preview.toolset) lines.push(`Toolset: ${preview.toolset}`);
  if (preview.allowedTools?.length) lines.push(`Allowed tools: ${preview.allowedTools.join(', ')}`);
  if (preview.cwd) lines.push(`Working directory: ${preview.cwd}`);
  if (preview.files?.length) {
    lines.push('Files:');
    for (const file of preview.files) lines.push(`- ${file.exists ? 'ok' : 'missing'} ${file.path}`);
  }
  if (preview.workflow) {
    lines.push(`Workflow: ${preview.workflow.name} (${preview.workflow.stepCount} steps)`);
    for (const step of preview.workflow.steps) {
      lines.push(`- Step ${step.step} ${step.type}${step.label ? ` ${step.label}` : ''}: ${step.ok ? 'ok' : 'failed'}`);
      for (const error of step.errors) lines.push(`  error: ${error}`);
      for (const warning of step.warnings) lines.push(`  warning: ${warning}`);
    }
  }
  for (const error of preview.errors) lines.push(`Error: ${error}`);
  for (const warning of preview.warnings) lines.push(`Warning: ${warning}`);
  return lines.join('\n');
}

interface UsageMetrics {
  durationMs?: number;
  apiDurationMs?: number;
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
  model?: string;
}

function extractUsageMetrics(msg: Record<string, unknown> | null): UsageMetrics {
  if (!msg) return {};
  const usage = asRecord(msg['usage']);
  const metrics: UsageMetrics = {
    durationMs: readNumber(msg, ['duration_ms', 'durationMs']),
    apiDurationMs: readNumber(msg, ['duration_api_ms', 'api_duration_ms', 'apiDurationMs']),
    totalCostUsd: readNumber(msg, ['total_cost_usd', 'totalCostUsd']),
    inputTokens: readNumber(msg, ['input_tokens', 'inputTokens']) ?? readNumber(usage, ['input_tokens', 'inputTokens']),
    outputTokens: readNumber(msg, ['output_tokens', 'outputTokens']) ?? readNumber(usage, ['output_tokens', 'outputTokens']),
    cacheReadTokens: readNumber(msg, ['cache_read_input_tokens', 'cacheReadInputTokens']) ?? readNumber(usage, ['cache_read_input_tokens', 'cacheReadInputTokens']),
    cacheCreationTokens: readNumber(msg, ['cache_creation_input_tokens', 'cacheCreationInputTokens']) ?? readNumber(usage, ['cache_creation_input_tokens', 'cacheCreationInputTokens']),
    model: readString(msg, ['model']) ?? readString(usage, ['model']),
  };
  metrics.totalTokens =
    readNumber(msg, ['total_tokens', 'totalTokens']) ??
    readNumber(usage, ['total_tokens', 'totalTokens']) ??
    sumDefined(metrics.inputTokens, metrics.outputTokens, metrics.cacheReadTokens, metrics.cacheCreationTokens);
  return metrics;
}

function extractToolNames(msg: Record<string, unknown>): string[] {
  if (msg['type'] !== 'assistant') return [];
  const message = asRecord(msg['message']);
  const content = message ? message['content'] : undefined;
  if (!Array.isArray(content)) return [];
  return content
    .map((block) => asRecord(block))
    .filter((block): block is Record<string, unknown> => Boolean(block))
    .filter((block) => block['type'] === 'tool_use')
    .map((block) => readString(block, ['name']))
    .filter((name): name is string => Boolean(name));
}

function buildEfficiencyHints(
  result: JobResult,
  toolset: string | undefined,
  allowedTools: string[]
): EfficiencyHint[] {
  const hints: EfficiencyHint[] = [];
  const cost = result.totalCostUsd ?? 0;
  const duration = result.durationMs ?? 0;
  const outputChars = result.outputChars ?? result.textOutput?.length ?? 0;
  const toolsUsed = result.toolsUsed ?? [];

  if (cost >= 1) {
    hints.push({ type: 'cost', severity: 'warn', message: `High run cost: $${cost.toFixed(2)}.` });
  } else if (cost >= 0.25) {
    hints.push({ type: 'cost', severity: 'info', message: `Moderate run cost: $${cost.toFixed(2)}.` });
  }

  if (duration >= 10 * 60 * 1000) {
    hints.push({ type: 'duration', severity: 'warn', message: `Long run: ${Math.round(duration / 60000)} minutes.` });
  }

  if (result.ok && outputChars < 80 && !result.cardFiles.length && !result.postedMessageIds.length && !result.childJobIds.length) {
    hints.push({ type: 'empty_output', severity: 'info', message: 'Run produced little stored output.' });
  }

  if (toolset && ['default', 'extended', 'code', 'web'].includes(toolset) && toolsUsed.length > 0) {
    const writeTools = new Set(['Write', 'Edit', 'Bash']);
    const webTools = new Set(['WebSearch', 'WebFetch']);
    const usedWrite = toolsUsed.some((tool) => writeTools.has(tool));
    const usedWeb = toolsUsed.some((tool) => webTools.has(tool));
    if (toolset === 'extended' && !usedWrite) {
      hints.push({ type: 'toolset', severity: 'info', message: 'Extended toolset was not used for write/edit/bash tools.' });
    }
    if ((toolset === 'default' || toolset === 'extended') && !usedWeb && toolsUsed.every((tool) => ['Read', 'Grep', 'Glob', 'PostMessage', 'GetJobStatus'].includes(tool))) {
      hints.push({ type: 'toolset', severity: 'info', message: 'This may fit the vault-readonly toolset.' });
    }
  }

  if (allowedTools.length > 0 && toolsUsed.length === 0 && result.ok) {
    hints.push({ type: 'toolset', severity: 'info', message: 'No tools were used; this step may not need an agent/tool-enabled run.' });
  }

  return hints;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readNumber(obj: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function readString(obj: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => typeof value === 'number');
  return defined.length > 0 ? defined.reduce((sum, value) => sum + value, 0) : undefined;
}

function parseClaudeEvent(msg: Record<string, unknown>): JobEvent | null {
  const type = msg['type'] as string | undefined;

  if (type === 'assistant') {
    const content = msg['message'] as Record<string, unknown> | undefined;
    if (!content) return null;
    const msgContent = content['content'] as unknown[] | undefined;
    if (!Array.isArray(msgContent)) return null;
    for (const block of msgContent) {
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text') {
        return { type: 'text', text: b['text'] as string };
      }
      if (b['type'] === 'tool_use') {
        return {
          type: 'tool',
          tool: b['name'] as string,
          input: b['input'],
        };
      }
    }
    return null;
  }

  if (type === 'tool_result') {
    return {
      type: 'tool',
      output: msg['content'],
    };
  }

  if (type === 'result') {
    return null; // handled at job completion
  }

  return null;
}
