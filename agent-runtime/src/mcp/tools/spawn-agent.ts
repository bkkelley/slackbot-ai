import { AgentJob, JobResult } from '../../types.js';
import { JobQueue } from '../../job-queue.js';
import { Logger } from '../../logger.js';

const logger = new Logger('spawn-agent');

export interface SpawnAgentInput {
  agent?: string;
  action?: string;
  prompt?: string;
  mode: 'sync' | 'async';
  files?: string[];
  replyText?: string;
  outputChannel?: { platform: string; id: string };
  threadId?: string;
  toolset?: string;
  scope?: string;
  model?: string;
}

export interface SpawnAgentResult {
  ok: boolean;
  jobId?: string;
  result?: JobResult;
  error?: string;
}

// The runInline function is provided by the Executor to avoid circular deps.
export type InlineRunner = (
  childJob: AgentJob,
  parentJobId: string
) => Promise<JobResult>;

export async function spawnAgentTool(
  parentJobId: string,
  input: SpawnAgentInput,
  queue: JobQueue,
  runInline: InlineRunner
): Promise<SpawnAgentResult> {
  const childJob = queue.enqueue({
    agent: input.agent,
    action: input.action,
    prompt: input.prompt,
    mode: input.mode,
    toolset: input.toolset ?? 'default',
    scope: input.scope,
    model: input.model,
    trigger: 'spawn',
    parentJobId,
    files: input.files,
    replyText: input.replyText,
    outputChannel: input.outputChannel,
    threadId: input.threadId,
  });

  logger.info('Child job enqueued via SpawnAgent', {
    childJobId: childJob.id,
    parentJobId,
    mode: input.mode,
    agent: input.agent,
    action: input.action,
  });

  if (input.mode === 'sync') {
    // Remove from pending queue so executor doesn't double-run it
    const result = await runInline(childJob, parentJobId);
    return { ok: result.ok, jobId: childJob.id, result };
  } else {
    return { ok: true, jobId: childJob.id };
  }
}
