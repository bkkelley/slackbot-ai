export interface AgentJob {
  // identity
  id: string;

  // prompt source — one of these patterns is required
  agent?: string;          // loads ~/.claude/agents/<name>.md (or <workspace>/.claude/agents/<name>.md if scope set)
  action?: string;         // resolves shared action templates from .agents/actions
  prompt?: string;         // raw: skip vault assembly, use this directly
  workflow?: string;       // workflow: runs steps from admin/_workflows/<name>.md sequentially
  scope?: string;          // workspace name for project-scoped agents (undefined = global)
  model?: string;          // optional Claude model override for this job

  // execution
  mode: 'sync' | 'async' | 'preview';
  toolset: string;
  status: 'pending' | 'running' | 'done' | 'failed';

  // triggering
  trigger: 'manual' | 'schedule' | 'spawn';
  parentJobId?: string;

  // output routing
  outputChannel?: { platform: string; id: string };
  threadId?: string;

  // context injection (vault-based jobs only)
  files?: string[];
  replyText?: string;
  sessionId?: string;
  workflowContext?: string;  // previous step output, injected by workflow-executor

  // scheduling (in job templates / jobs.json)
  cron?: string;
  runAt?: string;

  // results (populated on completion)
  result?: JobResult;

  // timing
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  lastRun?: string;
}

export interface JobResult {
  ok: boolean;
  error?: string;
  postedMessageIds: string[];
  cardFiles: string[];
  childJobIds: string[];
  textOutput?: string;
  approvalIds?: string[];
  stepResults?: WorkflowStepResult[];
  durationMs?: number;
  apiDurationMs?: number;
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
  model?: string;
  toolCallCount?: number;
  toolsUsed?: string[];
  unusedAllowedTools?: string[];
  outputChars?: number;
  efficiencyHints?: EfficiencyHint[];
  preview?: JobPreview;
}

export interface JobPreview {
  kind: 'agent' | 'workflow' | 'prompt' | 'job';
  ok: boolean;
  errors: string[];
  warnings: string[];
  promptPreview?: string;
  promptChars?: number;
  cwd?: string;
  toolset?: string;
  allowedTools?: string[];
  outputChannel?: { platform: string; id: string };
  files?: Array<{ path: string; resolvedPath: string; exists: boolean }>;
  workflow?: {
    name: string;
    stepCount: number;
    steps: Array<{
      step: number;
      type: string;
      label?: string;
      ok: boolean;
      errors: string[];
      warnings: string[];
      controlFlow?: string[];
      promptChars?: number;
      toolset?: string;
      allowedTools?: string[];
    }>;
  };
}

export interface WorkflowStepResult {
  step: number;
  type: string;
  label?: string;
  status: 'done' | 'failed' | 'skipped' | 'approved' | 'denied' | 'timed_out';
  attempt?: number;
  maxAttempts?: number;
  visit?: number;
  childJobId?: string;
  approvalId?: string;
  error?: string;
  textOutput?: string;
  durationMs?: number;
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  toolCallCount?: number;
  toolsUsed?: string[];
  outputChars?: number;
  efficiencyHints?: EfficiencyHint[];
  startedAt: string;
  completedAt: string;
}

export interface EfficiencyHint {
  type: 'cost' | 'duration' | 'toolset' | 'empty_output' | 'approval' | 'merge_candidate';
  severity: 'info' | 'warn';
  message: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'timed_out';

export interface ApprovalRequest {
  id: string;
  workflowJobId: string;
  stepIndex: number;
  prompt: string;
  status: ApprovalStatus;
  outputChannel?: { platform: string; id: string };
  threadId?: string;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  comment?: string;
}

export interface AgentJobTemplate {
  id: string;
  agent?: string;
  action?: string;
  command?: string;       // shell command (non-agent jobs)
  prompt?: string;
  workflow?: string;
  scope?: string;         // workspace name for project-scoped agents
  model?: string;         // optional Claude model override
  mode?: 'sync' | 'async' | 'preview';
  toolset?: string;
  outputChannel?: { platform: string; id: string } | string; // string for backwards-compat
  threadId?: string;
  cron?: string;
  runAt?: string;
  enabled: boolean;
  lastRun?: string | null;
  description?: string;
}

export interface JobEvent {
  type: 'text' | 'tool' | 'status' | 'done';
  text?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  status?: 'running' | 'done' | 'failed';
  result?: JobResult;
}
