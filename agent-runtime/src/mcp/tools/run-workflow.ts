import { JobQueue } from '../../job-queue.js';
import { Logger } from '../../logger.js';
import { InlineRunner, SpawnAgentResult } from './spawn-agent.js';
import { loadWorkflow } from '../../workflow-executor.js';

const logger = new Logger('run-workflow');

export interface RunWorkflowInput {
  workflow: string;
  mode?: 'sync' | 'async';
  outputChannel?: { platform: string; id: string };
  threadId?: string;
  toolset?: 'default' | 'extended';
  model?: string;
}

export interface RunWorkflowResult extends SpawnAgentResult {
  workflowName?: string;
  steps?: number;
}

export async function runWorkflowTool(
  parentJobId: string,
  input: RunWorkflowInput,
  queue: JobQueue,
  runInline: InlineRunner
): Promise<RunWorkflowResult> {
  // Inherit scope from parent job
  const parentJob = queue.getJob(parentJobId);
  const scope = parentJob?.scope;

  // Validate workflow exists before enqueuing
  let stepCount: number;
  try {
    const def = loadWorkflow(input.workflow, scope);
    stepCount = def.steps.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Workflow not found', { workflow: input.workflow, scope });
    return { ok: false, error: msg };
  }

  const childJob = queue.enqueue({
    workflow: input.workflow,
    mode: input.mode ?? 'sync',
    toolset: input.toolset ?? 'default',
    model: input.model ?? parentJob?.model,
    trigger: 'spawn',
    parentJobId,
    scope,
    outputChannel: input.outputChannel,
    threadId: input.threadId,
  });

  logger.info('RunWorkflow enqueued', {
    workflow: input.workflow,
    childJobId: childJob.id,
    mode: input.mode ?? 'sync',
    parentJobId,
  });

  if ((input.mode ?? 'sync') === 'sync') {
    const result = await runInline(childJob, parentJobId);
    return { ok: result.ok, jobId: childJob.id, result, workflowName: input.workflow, steps: stepCount };
  }

  return { ok: true, jobId: childJob.id, workflowName: input.workflow, steps: stepCount };
}
