import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { AgentJob, ApprovalStatus, EfficiencyHint, JobPreview, JobResult, WorkflowStepResult } from './types.js';
import { JobQueue } from './job-queue.js';
import { InlineRunner } from './mcp/tools/spawn-agent.js';
import { Logger } from './logger.js';
import { createRequire } from 'module';

const logger = new Logger('workflow-executor');
const require = createRequire(import.meta.url);
const { assertSafeSegment, optionalScope, safeJoin, safeMarkdownFile } = require('../../shared/path-guard.js');
const { findSkillFile, skillSearchSummary } = require('../../shared/skill-resolver.js');

const VAULT_PATH = process.env.VAULT_PATH || `${process.env.HOME}/claude-workspaces/global`;
const BASE_DIRECTORY = process.env.BASE_DIRECTORY || `${process.env.HOME}/claude-workspaces`;
const BOT_HTTP_PORT = process.env.BOT_HTTP_PORT || '3458';
const BOT_RUNTIME_SHARED_SECRET = process.env.BOT_RUNTIME_SHARED_SECRET || '';

export interface WorkflowStep {
  type: 'agent' | 'skill' | 'workflow' | 'approval';
  // agent step
  agent?: string;
  action?: string;
  // skill step
  skill?: string;
  args?: string;
  agentScope?: string;
  // workflow step
  workflow?: string;
  // approval step
  prompt?: string;
  timeoutMinutes?: number;
  onDeny?: 'abort' | 'continue';
  onTimeout?: 'abort' | 'continue';
  // shared
  toolset?: string;
  model?: string;
  outputChannel?: { platform: string; id: string };
  runIf?: 'always' | 'previous_succeeded' | 'previous_failed' | 'previous_output_includes' | 'previous_output_excludes';
  runIfText?: string;
  onFailure?: 'abort' | 'continue';
  maxAttempts?: number | string;
  maxVisits?: number | string;
  successWhen?: 'job_ok' | 'output_includes' | 'output_excludes';
  successText?: string;
  jumpOnSuccess?: number | string;
  jumpOnFailure?: number | string;
}

export interface WorkflowDef {
  name: string;
  steps: WorkflowStep[];
  outputChannel?: { platform: string; id: string };
  body?: string;
}

export function loadWorkflow(name: string, scope?: string): WorkflowDef {
  const workflowName = assertSafeSegment(name, 'workflow name');
  const safeScope = optionalScope(scope);
  // Project-scoped workflow first, then global vault
  const projectPath = safeScope
    ? safeMarkdownFile(safeJoin(BASE_DIRECTORY, safeScope, '.agents', 'workflows'), workflowName, 'workflow name')
    : null;
  const vaultPath = safeMarkdownFile(safeJoin(VAULT_PATH, '_workflows'), workflowName, 'workflow name');
  const filePath =
    projectPath && fs.existsSync(projectPath) ? projectPath : vaultPath;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Workflow file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`Workflow file has no YAML frontmatter: ${filePath}`);
  }

  const parsed = yaml.load(match[1]) as Record<string, unknown>;
  if (!Array.isArray(parsed['steps'])) {
    throw new Error(`Workflow "${name}" has no steps array in frontmatter`);
  }

  return {
    name: (parsed['name'] as string) ?? workflowName,
    steps: parsed['steps'] as WorkflowStep[],
    outputChannel: parsed['outputChannel'] as WorkflowDef['outputChannel'] | undefined,
    body: match[2] ?? '',
  };
}

export async function previewWorkflow(
  workflowJob: AgentJob,
  previewAgentJob: (job: AgentJob) => Promise<JobPreview>
): Promise<JobPreview> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const workflowName = assertSafeSegment(workflowJob.workflow!, 'workflow name');
  let def: WorkflowDef;

  try {
    def = loadWorkflow(workflowName, workflowJob.scope);
  } catch (err) {
    return {
      kind: 'workflow',
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
      warnings,
      workflow: { name: workflowName, stepCount: 0, steps: [] },
    };
  }

  const workflowOutputChannel = workflowJob.outputChannel ?? def.outputChannel;
  if (workflowOutputChannel && (!workflowOutputChannel.platform || !workflowOutputChannel.id)) {
    errors.push('Workflow output channel must include platform and id.');
  }

  const steps: NonNullable<JobPreview['workflow']>['steps'] = [];
  let priorOutput = workflowJob.workflowContext ?? workflowJob.replyText;

  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i]!;
    const stepErrors: string[] = [];
    const stepWarnings: string[] = [];
    let stepPreview: JobPreview | null = null;
    let label = step.agent ?? step.skill ?? step.workflow ?? step.prompt;

    const childJobBase: AgentJob = {
      id: `${workflowJob.id}:preview:${i + 1}`,
      mode: 'preview',
      status: 'running',
      createdAt: workflowJob.createdAt,
      toolset: step.toolset ?? workflowJob.toolset ?? 'default',
      model: step.model ?? workflowJob.model,
      trigger: 'spawn',
      parentJobId: workflowJob.id,
      scope: workflowJob.scope,
      outputChannel: step.outputChannel ?? workflowOutputChannel,
      threadId: workflowJob.threadId,
      files: workflowJob.files,
      workflowContext: priorOutput,
    };

    if (step.type === 'agent') {
      if (!step.agent) {
        stepErrors.push('Workflow step missing agent name.');
      } else {
        stepPreview = await previewAgentJob({ ...childJobBase, agent: step.agent, action: step.action });
      }
    } else if (step.type === 'skill') {
      if (!step.skill) {
        stepErrors.push('Workflow step missing skill name.');
      } else {
        const skillFile = findSkillFile({ skill: step.skill, scope: workflowJob.scope, agent: step.agent, agentScope: step.agentScope });
        if (!skillFile) {
          stepErrors.push(`Skill "${step.skill}" not found. Searched: ${skillSearchSummary({ skill: step.skill, scope: workflowJob.scope, agent: step.agent, agentScope: step.agentScope })}`);
        } else {
          const skillContent = fs.readFileSync(skillFile.path, 'utf8');
          const prompt = step.args ? `${skillContent}\n\n---\n\n${step.args}` : skillContent;
          stepPreview = await previewAgentJob({ ...childJobBase, prompt });
        }
      }
    } else if (step.type === 'workflow') {
      if (!step.workflow) {
        stepErrors.push('Workflow step missing workflow name.');
      } else {
        try {
          const nested = loadWorkflow(step.workflow, workflowJob.scope);
          stepWarnings.push(`Nested workflow "${nested.name}" has ${nested.steps.length} step${nested.steps.length === 1 ? '' : 's'}; nested steps are not expanded in this preview.`);
        } catch (err) {
          stepErrors.push(err instanceof Error ? err.message : String(err));
        }
      }
    } else if (step.type === 'approval') {
      if (!step.prompt) stepWarnings.push('Approval step uses the default prompt.');
      priorOutput = `Approval preview for step ${i + 1}.`;
    } else {
      stepErrors.push(`Unknown workflow step type: ${(step as WorkflowStep).type}`);
    }

    if (stepPreview) {
      stepErrors.push(...stepPreview.errors);
      stepWarnings.push(...stepPreview.warnings);
    }
    validateAdaptiveFields(step, i + 1, def.steps.length, stepWarnings);
    validateMarkerContracts(step, i + 1, stepPreview, def.body, stepWarnings);
    const controlFlow = describeAdaptiveFlow(step, i + 1, def.steps.length);

    steps.push({
      step: i + 1,
      type: step.type,
      label,
      ok: stepErrors.length === 0,
      errors: stepErrors,
      warnings: stepWarnings,
      controlFlow,
      promptChars: stepPreview?.promptChars,
      toolset: stepPreview?.toolset,
      allowedTools: stepPreview?.allowedTools,
    });
  }

  for (const step of steps) {
    errors.push(...step.errors.map((error) => `Step ${step.step}: ${error}`));
    warnings.push(...step.warnings.map((warning) => `Step ${step.step}: ${warning}`));
  }

  return {
    kind: 'workflow',
    ok: errors.length === 0,
    errors,
    warnings,
    outputChannel: workflowOutputChannel,
    workflow: {
      name: def.name,
      stepCount: def.steps.length,
      steps,
    },
  };
}

export async function runWorkflow(
  workflowJob: AgentJob,
  queue: JobQueue,
  runInline: InlineRunner
): Promise<JobResult> {
  const workflowName = assertSafeSegment(workflowJob.workflow!, 'workflow name');
  let def: WorkflowDef;

  try {
    def = loadWorkflow(workflowName, workflowJob.scope);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error('Failed to load workflow', { workflowName, error });
    return { ok: false, error, postedMessageIds: [], cardFiles: [], childJobIds: [] };
  }

  logger.info('Running workflow', { workflowName, steps: def.steps.length, jobId: workflowJob.id });
  const workflowOutputChannel = workflowJob.outputChannel ?? def.outputChannel;
  const validationErrors = validateWorkflowForRun(def);
  if (validationErrors.length > 0) {
    const error = validationErrors.join('; ');
    logger.error('Workflow validation failed', { workflowName, error });
    return { ok: false, error, postedMessageIds: [], cardFiles: [], childJobIds: [] };
  }

  const allCardFiles: string[] = [];
  const allPostedMessageIds: string[] = [];
  const allChildJobIds: string[] = [];
  const allApprovalIds: string[] = [];
  const stepResults: WorkflowStepResult[] = [];
  let priorOutput: string | undefined = workflowJob.workflowContext ?? workflowJob.replyText;
  let priorStatus: WorkflowStepResult['status'] | undefined;
  const visitCounts = new Map<number, number>();
  let i = 0;
  let transitions = 0;
  const maxTransitions = Math.max(20, def.steps.length * 12);

  while (i < def.steps.length) {
    transitions += 1;
    if (transitions > maxTransitions) {
      const error = `Workflow exceeded ${maxTransitions} step transitions; check jumpOnSuccess/jumpOnFailure loops.`;
      logger.error('Workflow transition limit exceeded', { workflowName, maxTransitions });
      return {
        ok: false,
        error,
        postedMessageIds: allPostedMessageIds,
        cardFiles: allCardFiles,
        childJobIds: allChildJobIds,
        approvalIds: allApprovalIds,
        stepResults,
        textOutput: priorOutput,
      };
    }

    const step = def.steps[i]!;
    const stepStartedAt = new Date().toISOString();
    const visit = (visitCounts.get(i) ?? 0) + 1;
    visitCounts.set(i, visit);
    const maxVisits = positiveInt(step.maxVisits, 3);
    logger.info('Workflow step', { workflowName, step: i + 1, total: def.steps.length, type: step.type, visit });

    if (visit > maxVisits) {
      const error = `Step ${i + 1} exceeded maxVisits=${maxVisits}`;
      stepResults.push(makeStepResult(i, step, 'failed', stepStartedAt, { error, visit }));
      return {
        ok: false,
        error,
        postedMessageIds: allPostedMessageIds,
        cardFiles: allCardFiles,
        childJobIds: allChildJobIds,
        approvalIds: allApprovalIds,
        stepResults,
        textOutput: priorOutput,
      };
    }

    if (!shouldRunStep(step, priorStatus, priorOutput)) {
      stepResults.push(makeStepResult(i, step, 'skipped', stepStartedAt, {
        textOutput: `Skipped by runIf=${step.runIf ?? 'always'}.`,
        visit,
      }));
      priorStatus = 'skipped';
      i += 1;
      continue;
    }

    const childJobBase: Omit<AgentJob, 'id' | 'status' | 'createdAt'> = {
      mode: 'sync',
      toolset: step.toolset ?? workflowJob.toolset ?? 'default',
      model: step.model ?? workflowJob.model,
      trigger: 'spawn',
      parentJobId: workflowJob.id,
      scope: workflowJob.scope,
      outputChannel: step.outputChannel ?? workflowOutputChannel,
      threadId: workflowJob.threadId,
      files: workflowJob.files,
      workflowContext: priorOutput,
    };

    let childJob: AgentJob;
    const maxAttempts = positiveInt(step.maxAttempts, 1);

    if (step.type === 'agent') {
      if (!step.agent) {
        logger.warn('Workflow step missing agent name — skipping', { step: i + 1 });
        stepResults.push(makeStepResult(i, step, 'skipped', stepStartedAt, {
          error: 'Workflow step missing agent name',
          visit,
        }));
        priorStatus = 'skipped';
        i += 1;
        continue;
      }
    } else if (step.type === 'skill') {
      if (!step.skill) {
        logger.warn('Workflow step missing skill name — skipping', { step: i + 1 });
        stepResults.push(makeStepResult(i, step, 'skipped', stepStartedAt, {
          error: 'Workflow step missing skill name',
          visit,
        }));
        priorStatus = 'skipped';
        i += 1;
        continue;
      }
      const skillFile = findSkillFile({ skill: step.skill, scope: workflowJob.scope, agent: step.agent, agentScope: step.agentScope });
      if (!skillFile) {
        const error = `Skill "${step.skill}" not found. Searched: ${skillSearchSummary({ skill: step.skill, scope: workflowJob.scope, agent: step.agent, agentScope: step.agentScope })}`;
        stepResults.push(makeStepResult(i, step, 'failed', stepStartedAt, { error, visit }));
        return {
          ok: false,
          error,
          postedMessageIds: allPostedMessageIds,
          cardFiles: allCardFiles,
          childJobIds: allChildJobIds,
          approvalIds: allApprovalIds,
          stepResults,
          textOutput: priorOutput,
        };
      }
    } else if (step.type === 'workflow') {
      if (!step.workflow) {
        logger.warn('Workflow step missing workflow name — skipping', { step: i + 1 });
        stepResults.push(makeStepResult(i, step, 'skipped', stepStartedAt, {
          error: 'Workflow step missing workflow name',
          visit,
        }));
        priorStatus = 'skipped';
        i += 1;
        continue;
      }
    } else if (step.type === 'approval') {
      const prompt = step.prompt ?? `Approve workflow "${workflowName}" step ${i + 1}?`;
      const timeoutMinutes = step.timeoutMinutes ?? 60;
      const approval = queue.createApproval({
        workflowJobId: workflowJob.id,
        stepIndex: i + 1,
        prompt,
        outputChannel: step.outputChannel ?? workflowOutputChannel,
        threadId: workflowJob.threadId,
      });
      allApprovalIds.push(approval.id);
      notifyApproval(approval.id, prompt, step.outputChannel ?? workflowOutputChannel, workflowJob.threadId).catch((err) => {
        logger.warn('Failed to notify approval channel', {
          workflowName,
          step: i + 1,
          approvalId: approval.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      logger.info('Workflow waiting for approval', {
        workflowName,
        step: i + 1,
        approvalId: approval.id,
        timeoutMinutes,
      });

      const resolved = await queue.waitForApproval(
        approval.id,
        Math.max(1, timeoutMinutes) * 60 * 1000
      );
      const status = approvalStatusToStepStatus(resolved.status);
      const output = `Approval ${resolved.status}${resolved.comment ? `: ${resolved.comment}` : ''}`;
      priorOutput = output;
      priorStatus = status;
      stepResults.push(makeStepResult(i, step, status, stepStartedAt, {
        approvalId: approval.id,
        textOutput: output,
        durationMs: new Date().getTime() - new Date(stepStartedAt).getTime(),
        outputChars: output.length,
        visit,
        efficiencyHints: [
          {
            type: 'approval',
            severity: resolved.status === 'approved' ? 'info' : 'warn',
            message: `Approval ${resolved.status}.`,
          },
        ],
      }));

      if (resolved.status === 'denied' && (step.onDeny ?? 'abort') === 'abort') {
        return {
          ok: false,
          error: `Step ${i + 1} approval denied`,
          postedMessageIds: allPostedMessageIds,
          cardFiles: allCardFiles,
          childJobIds: allChildJobIds,
          approvalIds: allApprovalIds,
          stepResults,
          textOutput: priorOutput,
        };
      }
      if (resolved.status === 'timed_out' && (step.onTimeout ?? 'abort') === 'abort') {
        return {
          ok: false,
          error: `Step ${i + 1} approval timed out`,
          postedMessageIds: allPostedMessageIds,
          cardFiles: allCardFiles,
          childJobIds: allChildJobIds,
          approvalIds: allApprovalIds,
          stepResults,
          textOutput: priorOutput,
        };
      }

      i += 1;
      continue;
    } else {
      logger.warn('Unknown workflow step type — skipping', { step: i + 1, type: (step as WorkflowStep).type });
      stepResults.push(makeStepResult(i, step, 'skipped', stepStartedAt, {
        error: `Unknown workflow step type: ${(step as WorkflowStep).type}`,
        visit,
      }));
      priorStatus = 'skipped';
      i += 1;
      continue;
    }

    let stepSucceeded = false;
    let finalError: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptStartedAt = new Date().toISOString();
      if (step.type === 'agent') {
        childJob = queue.enqueue({ ...childJobBase, workflowContext: priorOutput, agent: step.agent, action: step.action });
      } else if (step.type === 'skill') {
        const skillFile = findSkillFile({ skill: step.skill!, scope: workflowJob.scope, agent: step.agent, agentScope: step.agentScope });
        const skillContent = fs.readFileSync(skillFile!.path, 'utf8');
        const prompt = step.args ? `${skillContent}\n\n---\n\n${step.args}` : skillContent;
        childJob = queue.enqueue({ ...childJobBase, workflowContext: priorOutput, prompt });
      } else {
        childJob = queue.enqueue({ ...childJobBase, workflowContext: priorOutput, workflow: step.workflow });
      }

      const result = await runInline(childJob, workflowJob.id);
      const successCheck = stepSucceededBy(step, result);
      stepSucceeded = successCheck.ok;
      finalError = successCheck.error ?? result.error;

      allChildJobIds.push(childJob.id);
      allCardFiles.push(...result.cardFiles);
      allPostedMessageIds.push(...result.postedMessageIds);
      allChildJobIds.push(...result.childJobIds);
      priorOutput = result.textOutput;
      stepResults.push(makeStepResult(i, step, stepSucceeded ? 'done' : 'failed', attemptStartedAt, {
        childJobId: childJob.id,
        error: finalError,
        textOutput: result.textOutput,
        durationMs: result.durationMs ?? (new Date().getTime() - new Date(attemptStartedAt).getTime()),
        totalCostUsd: result.totalCostUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        totalTokens: result.totalTokens,
        toolCallCount: result.toolCallCount,
        toolsUsed: result.toolsUsed,
        outputChars: result.outputChars ?? result.textOutput?.length ?? 0,
        efficiencyHints: stepEfficiencyHints(step, result),
        attempt,
        maxAttempts,
        visit,
      }));

      if (stepSucceeded) break;
      if (attempt < maxAttempts) {
        priorOutput = [
          result.textOutput,
          finalError ? `Previous attempt failed: ${finalError}` : '',
          `Retrying step ${i + 1}, attempt ${attempt + 1} of ${maxAttempts}.`,
        ].filter(Boolean).join('\n\n');
      }
    }

    priorStatus = stepSucceeded ? 'done' : 'failed';

    if (!stepSucceeded) {
      logger.error('Workflow step failed — aborting', {
        workflowName,
        step: i + 1,
        error: finalError,
      });
      const jump = stepIndexFrom(step.jumpOnFailure, def.steps.length);
      if (jump !== null) {
        i = jump;
        continue;
      }
      if ((step.onFailure ?? 'abort') === 'continue') {
        i += 1;
        continue;
      }
      return {
        ok: false,
        error: `Step ${i + 1} (${step.type}) failed: ${finalError}`,
        postedMessageIds: allPostedMessageIds,
        cardFiles: allCardFiles,
        childJobIds: allChildJobIds,
        approvalIds: allApprovalIds,
        stepResults,
        textOutput: priorOutput,
      };
    }

    const jump = stepIndexFrom(step.jumpOnSuccess, def.steps.length);
    i = jump ?? i + 1;
  }

  logger.info('Workflow completed', { workflowName, steps: def.steps.length });

  return {
    ok: true,
    postedMessageIds: allPostedMessageIds,
    cardFiles: allCardFiles,
    childJobIds: allChildJobIds,
    approvalIds: allApprovalIds,
    stepResults,
    ...aggregateWorkflowMetrics(stepResults),
    efficiencyHints: workflowEfficiencyHints(stepResults),
    textOutput: priorOutput,
  };
}

function makeStepResult(
  index: number,
  step: WorkflowStep,
  status: WorkflowStepResult['status'],
  startedAt: string,
  extra: Partial<WorkflowStepResult> = {}
): WorkflowStepResult {
  return {
    step: index + 1,
    type: step.type,
    label: step.agent ?? step.skill ?? step.workflow ?? step.prompt,
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    ...extra,
  };
}

function positiveInt(value: number | string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function stepIndexFrom(value: number | string | undefined, stepCount: number): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > stepCount) return null;
  return parsed - 1;
}

function shouldRunStep(
  step: WorkflowStep,
  priorStatus: WorkflowStepResult['status'] | undefined,
  priorOutput: string | undefined
): boolean {
  const runIf = step.runIf ?? 'always';
  if (runIf === 'always') return true;
  if (runIf === 'previous_succeeded') return priorStatus === 'done' || priorStatus === 'approved';
  if (runIf === 'previous_failed') return ['failed', 'denied', 'timed_out'].includes(priorStatus ?? '');
  if (runIf === 'previous_output_includes') return Boolean(step.runIfText && containsMarker(priorOutput ?? '', step.runIfText));
  if (runIf === 'previous_output_excludes') return Boolean(step.runIfText && !containsMarker(priorOutput ?? '', step.runIfText));
  return true;
}

function stepSucceededBy(step: WorkflowStep, result: JobResult): { ok: boolean; error?: string } {
  if (!result.ok) return { ok: false, error: result.error };
  const successWhen = step.successWhen ?? 'job_ok';
  const output = result.textOutput ?? '';
  if (successWhen === 'output_includes') {
    if (!step.successText) return { ok: false, error: 'successWhen=output_includes requires successText' };
    return containsMarker(output, step.successText)
      ? { ok: true }
      : { ok: false, error: `Output did not include successText: ${step.successText}` };
  }
  if (successWhen === 'output_excludes') {
    if (!step.successText) return { ok: false, error: 'successWhen=output_excludes requires successText' };
    return !containsMarker(output, step.successText)
      ? { ok: true }
      : { ok: false, error: `Output included excluded successText: ${step.successText}` };
  }
  return { ok: true };
}

function validateWorkflowForRun(def: WorkflowDef): string[] {
  const errors: string[] = [];
  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i]!;
    const stepNumber = i + 1;
    if (step.maxAttempts !== undefined && !isPositiveInteger(step.maxAttempts)) {
      errors.push(`Step ${stepNumber}: maxAttempts must be at least 1`);
    }
    if (step.maxVisits !== undefined && !isPositiveInteger(step.maxVisits)) {
      errors.push(`Step ${stepNumber}: maxVisits must be at least 1`);
    }
    if ((step.successWhen === 'output_includes' || step.successWhen === 'output_excludes') && !step.successText) {
      errors.push(`Step ${stepNumber}: successText is required for ${step.successWhen}`);
    }
    if ((step.runIf === 'previous_output_includes' || step.runIf === 'previous_output_excludes') && !step.runIfText) {
      errors.push(`Step ${stepNumber}: runIfText is required for ${step.runIf}`);
    }
    for (const [field, value] of Object.entries({ jumpOnSuccess: step.jumpOnSuccess, jumpOnFailure: step.jumpOnFailure })) {
      if (value !== undefined && stepIndexFrom(value, def.steps.length) === null) {
        errors.push(`Step ${stepNumber}: ${field} must point to a valid 1-based step number`);
      }
    }
  }
  return errors;
}

function validateAdaptiveFields(step: WorkflowStep, stepNumber: number, stepCount: number, warnings: string[]): void {
  if (step.maxAttempts !== undefined && !isPositiveInteger(step.maxAttempts)) {
    warnings.push(`Step ${stepNumber}: maxAttempts must be at least 1.`);
  }
  if (step.maxVisits !== undefined && !isPositiveInteger(step.maxVisits)) {
    warnings.push(`Step ${stepNumber}: maxVisits must be at least 1.`);
  }
  if ((step.successWhen === 'output_includes' || step.successWhen === 'output_excludes') && !step.successText) {
    warnings.push(`Step ${stepNumber}: successText is required for ${step.successWhen}.`);
  }
  if ((step.runIf === 'previous_output_includes' || step.runIf === 'previous_output_excludes') && !step.runIfText) {
    warnings.push(`Step ${stepNumber}: runIfText is required for ${step.runIf}.`);
  }
  for (const [field, value] of Object.entries({ jumpOnSuccess: step.jumpOnSuccess, jumpOnFailure: step.jumpOnFailure })) {
    if (value !== undefined && stepIndexFrom(value, stepCount) === null) {
      warnings.push(`Step ${stepNumber}: ${field} must point to a valid 1-based step number.`);
    }
  }
  if (step.jumpOnSuccess !== undefined && stepIndexFrom(step.jumpOnSuccess, stepCount) === stepNumber - 1 && step.maxVisits === undefined) {
    warnings.push(`Step ${stepNumber}: jumpOnSuccess points to itself; set maxVisits to bound the loop.`);
  }
  if (step.jumpOnFailure !== undefined && stepIndexFrom(step.jumpOnFailure, stepCount) === stepNumber - 1 && step.maxVisits === undefined) {
    warnings.push(`Step ${stepNumber}: jumpOnFailure points to itself; set maxVisits to bound the loop.`);
  }
  if ((step.jumpOnSuccess !== undefined || step.jumpOnFailure !== undefined) && step.maxVisits === undefined) {
    warnings.push(`Step ${stepNumber}: jump loops default to maxVisits=3; set maxVisits explicitly if this is intentional.`);
  }
  if (step.runIf === 'previous_failed' && stepNumber === 1) {
    warnings.push(`Step ${stepNumber}: runIf=previous_failed cannot be true for the first step.`);
  }
  if ((step.runIf === 'previous_output_includes' || step.runIf === 'previous_output_excludes') && stepNumber === 1) {
    warnings.push(`Step ${stepNumber}: output-based runIf checks initial workflow input on the first step.`);
  }
}

function validateMarkerContracts(
  step: WorkflowStep,
  stepNumber: number,
  stepPreview: JobPreview | null,
  workflowBody: string | undefined,
  warnings: string[]
): void {
  const searchable = `${stepPreview?.promptPreview ?? ''}\n${workflowBody ?? ''}`;
  const successMarker = (step.successWhen === 'output_includes' || step.successWhen === 'output_excludes')
    ? step.successText
    : undefined;
  if (successMarker && !containsMarker(searchable, successMarker)) {
    warnings.push(`Step ${stepNumber}: successText "${successMarker}" is not mentioned in this step's assembled prompt or workflow notes.`);
  }

  const routeMarker = (step.runIf === 'previous_output_includes' || step.runIf === 'previous_output_excludes')
    ? step.runIfText
    : undefined;
  if (routeMarker && !containsMarker(searchable, routeMarker)) {
    warnings.push(`Step ${stepNumber}: runIfText "${routeMarker}" is not mentioned in this step's assembled prompt or workflow notes.`);
  }
}

function isPositiveInteger(value: number | string | undefined): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1;
}

function containsMarker(text: string, marker: string): boolean {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`);
  return pattern.test(text);
}

function describeAdaptiveFlow(step: WorkflowStep, stepNumber: number, stepCount: number): string[] {
  const notes: string[] = [];
  const maxAttempts = step.maxAttempts !== undefined ? positiveInt(step.maxAttempts, 1) : 1;
  const maxVisits = step.maxVisits !== undefined ? positiveInt(step.maxVisits, 3) : undefined;
  const runIf = step.runIf ?? 'always';
  const successWhen = step.successWhen ?? 'job_ok';

  if (runIf !== 'always') {
    if (runIf === 'previous_succeeded') notes.push('Runs only if the previous step succeeded.');
    if (runIf === 'previous_failed') notes.push('Runs only if the previous step failed, was denied, or timed out.');
    if (runIf === 'previous_output_includes') notes.push(`Runs only if previous output includes "${step.runIfText ?? ''}".`);
    if (runIf === 'previous_output_excludes') notes.push(`Runs only if previous output excludes "${step.runIfText ?? ''}".`);
  }

  if (maxAttempts > 1) {
    notes.push(`Retries this step up to ${maxAttempts} attempts before failure handling.`);
  }

  if (successWhen === 'output_includes') {
    notes.push(`Succeeds only if output includes "${step.successText ?? ''}".`);
  } else if (successWhen === 'output_excludes') {
    notes.push(`Succeeds only if output excludes "${step.successText ?? ''}".`);
  }

  const successTarget = stepIndexFrom(step.jumpOnSuccess, stepCount);
  if (successTarget !== null) {
    notes.push(`On success, jumps to step ${successTarget + 1}.`);
  }

  const failureTarget = stepIndexFrom(step.jumpOnFailure, stepCount);
  if (failureTarget !== null) {
    notes.push(`On failure, jumps to step ${failureTarget + 1}.`);
  } else if ((step.onFailure ?? 'abort') === 'continue') {
    notes.push('On failure, continues to the next step after retries are exhausted.');
  }

  if (maxVisits !== undefined) {
    notes.push(`May be visited up to ${maxVisits} times.`);
  } else if (successTarget !== null || failureTarget !== null) {
    notes.push('May be visited up to 3 times by default because this step participates in a jump loop.');
  }

  if (stepNumber === stepCount && (successTarget === null || successTarget === stepNumber)) {
    // No note needed for ordinary terminal steps.
  }

  return notes;
}

function approvalStatusToStepStatus(status: ApprovalStatus): WorkflowStepResult['status'] {
  if (status === 'approved') return 'approved';
  if (status === 'denied') return 'denied';
  if (status === 'timed_out') return 'timed_out';
  return 'failed';
}

async function notifyApproval(
  approvalId: string,
  prompt: string,
  outputChannel: { platform: string; id: string } | undefined,
  threadId: string | undefined
): Promise<void> {
  if (!outputChannel) return;
  const resp = await fetch(`http://127.0.0.1:${BOT_HTTP_PORT}/api/transport-proxy/approval`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bot-Auth': BOT_RUNTIME_SHARED_SECRET,
    },
    body: JSON.stringify({
      platform: outputChannel.platform,
      channelId: outputChannel.id,
      threadId,
      approvalId,
      prompt,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Bot returned ${resp.status}: ${body.slice(0, 200)}`);
  }
}

function aggregateWorkflowMetrics(steps: WorkflowStepResult[]): Partial<JobResult> {
  const tools = new Set<string>();
  for (const step of steps) {
    for (const tool of step.toolsUsed ?? []) tools.add(tool);
  }
  return {
    totalCostUsd: sum(steps.map((step) => step.totalCostUsd)),
    inputTokens: sum(steps.map((step) => step.inputTokens)),
    outputTokens: sum(steps.map((step) => step.outputTokens)),
    totalTokens: sum(steps.map((step) => step.totalTokens)),
    toolCallCount: sum(steps.map((step) => step.toolCallCount)),
    toolsUsed: Array.from(tools).sort(),
    outputChars: sum(steps.map((step) => step.outputChars)),
  };
}

function stepEfficiencyHints(step: WorkflowStep, result: JobResult): EfficiencyHint[] {
  const hints = [...(result.efficiencyHints ?? [])];
  if (result.ok && (result.outputChars ?? 0) < 80 && step.type !== 'approval') {
    hints.push({
      type: 'merge_candidate',
      severity: 'info',
      message: 'Low-output step; consider merging or skipping if downstream value is limited.',
    });
  }
  return hints;
}

function workflowEfficiencyHints(steps: WorkflowStepResult[]): EfficiencyHint[] {
  const hints: EfficiencyHint[] = [];
  const expensive = steps
    .filter((step) => (step.totalCostUsd ?? 0) >= 0.25)
    .sort((a, b) => (b.totalCostUsd ?? 0) - (a.totalCostUsd ?? 0))[0];
  if (expensive) {
    hints.push({
      type: 'cost',
      severity: 'info',
      message: `Most expensive step: #${expensive.step} at $${(expensive.totalCostUsd ?? 0).toFixed(2)}.`,
    });
  }

  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1]!;
    const current = steps[i]!;
    if (prev.type === current.type && prev.label && prev.label === current.label) {
      hints.push({
        type: 'merge_candidate',
        severity: 'info',
        message: `Steps #${prev.step} and #${current.step} repeat ${current.label}; consider collapsing them.`,
      });
    }
  }

  const autoApproved = steps.filter((step) => step.type === 'approval' && step.status === 'approved');
  if (autoApproved.length > 0) {
    hints.push({
      type: 'approval',
      severity: 'info',
      message: `${autoApproved.length} approval step${autoApproved.length === 1 ? '' : 's'} approved; review later if it becomes routine.`,
    });
  }
  return hints;
}

function sum(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => typeof value === 'number');
  return defined.length > 0 ? defined.reduce((total, value) => total + value, 0) : undefined;
}
