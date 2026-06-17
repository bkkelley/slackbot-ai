import Database from 'better-sqlite3';
import { AgentJob, ApprovalRequest, ApprovalStatus, JobResult } from './types.js';
import { randomUUID } from 'crypto';
import { BudgetUsage, checkBudget, loadBudgetPolicy, startOfLocalDayIso } from './budgets.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  data JSON NOT NULL,
  status TEXT NOT NULL,
  parent_job_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS jobs_parent_idx ON jobs(parent_job_id);

CREATE TABLE IF NOT EXISTS card_ids (
  card_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  card_file TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  data JSON NOT NULL,
  status TEXT NOT NULL,
  workflow_job_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS approvals_status_idx ON approval_requests(status, created_at);
CREATE INDEX IF NOT EXISTS approvals_workflow_idx ON approval_requests(workflow_job_id, step_index);
`;

const SCHEMA_VERSION = 2;

interface BudgetTrendMetrics {
  runs: number;
  costUsd: number;
  tokens: number;
  inputTokens: number;
}

interface BudgetTrendRow {
  scope: string;
  name: string;
  type: 'agent' | 'workflow' | 'direct';
  current: BudgetTrendMetrics & {
    avgCostUsd: number;
    avgTokens: number;
    avgInputTokens: number;
  };
  previous: BudgetTrendMetrics & {
    avgCostUsd: number;
    avgTokens: number;
    avgInputTokens: number;
  };
  costChangePct: number | null;
  avgCostChangePct: number | null;
  avgTokensChangePct: number | null;
  avgInputTokensChangePct: number | null;
  severity: 'info' | 'warn';
  reasons: string[];
}

export class JobQueue {
  private db: Database.Database;
  // In-memory set of pending job IDs in order
  private pendingIds: string[] = [];
  // waiters: jobId → array of resolve functions waiting for job completion
  private waiters: Map<string, Array<(result: JobResult) => void>> = new Map();
  private approvalWaiters: Map<string, Array<(approval: ApprovalRequest) => void>> = new Map();

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(SCHEMA);
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    // On startup: fail any jobs left in 'running' state
    this.db
      .prepare(
        `UPDATE jobs SET status='failed', data=json_patch(data, '{"status":"failed","result":{"ok":false,"error":"runtime restarted mid-execution","postedMessageIds":[],"cardFiles":[],"childJobIds":[]}}'), updated_at=? WHERE status='running'`
      )
      .run(new Date().toISOString());
    // Load pending jobs into memory
    const pending = this.db
      .prepare(`SELECT id FROM jobs WHERE status='pending' ORDER BY created_at ASC`)
      .all() as { id: string }[];
    this.pendingIds = pending.map((r) => r.id);
  }

  enqueue(job: Omit<AgentJob, 'id' | 'status' | 'createdAt'>): AgentJob {
    const budget = checkBudget(job, (sinceIso, filter) => this.getBudgetUsage(sinceIso, filter));
    if (!budget.ok) {
      throw new Error(`Budget exceeded: ${budget.reason}`);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const fullJob: AgentJob = { ...job, id, status: 'pending', createdAt: now };
    this.db
      .prepare(
        `INSERT INTO jobs (id, data, status, parent_job_id, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?, ?)`
      )
      .run(id, JSON.stringify(fullJob), job.parentJobId ?? null, now, now);
    this.pendingIds.push(id);
    return fullJob;
  }

  getBudgetUsage(
    sinceIso = startOfLocalDayIso(),
    filter?: {
      agent?: string;
      workflow?: string;
      toolset?: string;
      trigger?: AgentJob['trigger'];
    }
  ): BudgetUsage {
    let sql = `
      SELECT
        COUNT(*) as runs,
        COALESCE(SUM(CAST(json_extract(data, '$.result.totalCostUsd') AS REAL)), 0) as costUsd,
        COALESCE(SUM(CAST(json_extract(data, '$.result.totalTokens') AS INTEGER)), 0) as tokens
      FROM jobs
      WHERE created_at >= ?
    `;
    const params: unknown[] = [sinceIso];
    if (filter?.agent) {
      sql += ` AND json_extract(data, '$.agent') = ?`;
      params.push(filter.agent);
    }
    if (filter?.workflow) {
      sql += ` AND json_extract(data, '$.workflow') = ?`;
      params.push(filter.workflow);
    }
    if (filter?.toolset) {
      sql += ` AND json_extract(data, '$.toolset') = ?`;
      params.push(filter.toolset);
    }
    if (filter?.trigger) {
      sql += ` AND json_extract(data, '$.trigger') = ?`;
      params.push(filter.trigger);
    }
    const row = this.db.prepare(sql).get(...params) as { runs: number; costUsd: number; tokens: number } | undefined;
    return {
      runs: row?.runs ?? 0,
      costUsd: row?.costUsd ?? 0,
      tokens: row?.tokens ?? 0,
    };
  }

  getBudgetStatus(): {
    enabled: boolean;
    since: string;
    policy: ReturnType<typeof loadBudgetPolicy>;
    usage: {
      daily: BudgetUsage;
      agents: Record<string, BudgetUsage>;
      workflows: Record<string, BudgetUsage>;
      toolsets: Record<string, BudgetUsage>;
      triggers: Record<string, BudgetUsage>;
    };
    trends: BudgetTrendRow[];
  } {
    const policy = loadBudgetPolicy();
    const since = startOfLocalDayIso();
    const usage = {
      daily: this.getBudgetUsage(since),
      agents: {} as Record<string, BudgetUsage>,
      workflows: {} as Record<string, BudgetUsage>,
      toolsets: {} as Record<string, BudgetUsage>,
      triggers: {} as Record<string, BudgetUsage>,
    };
    for (const agent of Object.keys(policy.agents ?? {})) {
      usage.agents[agent] = this.getBudgetUsage(since, { agent });
    }
    for (const workflow of Object.keys(policy.workflows ?? {})) {
      usage.workflows[workflow] = this.getBudgetUsage(since, { workflow });
    }
    for (const toolset of Object.keys(policy.toolsets ?? {})) {
      usage.toolsets[toolset] = this.getBudgetUsage(since, { toolset });
    }
    for (const trigger of Object.keys(policy.triggers ?? {}) as AgentJob['trigger'][]) {
      usage.triggers[trigger] = this.getBudgetUsage(since, { trigger });
    }
    return {
      enabled: policy.enabled !== false,
      since,
      policy,
      usage,
      trends: this.getBudgetTrends(),
    };
  }

  getBudgetTrends(windowDays = 7): BudgetTrendRow[] {
    const now = Date.now();
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    const currentSince = new Date(now - windowMs).toISOString();
    const previousSince = new Date(now - windowMs * 2).toISOString();
    const previousUntil = currentSince;

    const rows = this.db
      .prepare(
        `SELECT data, created_at FROM jobs WHERE parent_job_id IS NULL AND status IN ('done', 'failed') AND created_at >= ? ORDER BY created_at DESC`
      )
      .all(previousSince) as { data: string; created_at: string }[];

    const trends = new Map<string, {
      name: string;
      type: 'agent' | 'workflow' | 'direct';
      current: BudgetTrendMetrics;
      previous: BudgetTrendMetrics;
    }>();

    const ensure = (job: AgentJob) => {
      const name = job.agent ?? job.workflow ?? '(direct)';
      const type: 'agent' | 'workflow' | 'direct' = job.agent ? 'agent' : job.workflow ? 'workflow' : 'direct';
      const key = `${type}:${name}`;
      const existing = trends.get(key);
      if (existing) return existing;
      const created = {
        name,
        type,
        current: emptyTrendMetrics(),
        previous: emptyTrendMetrics(),
      };
      trends.set(key, created);
      return created;
    };

    for (const row of rows) {
      const job = JSON.parse(row.data) as AgentJob;
      const target = row.created_at >= currentSince ? ensure(job).current : row.created_at >= previousSince && row.created_at < previousUntil ? ensure(job).previous : null;
      if (!target) continue;
      const result = job.result;
      target.runs += 1;
      target.costUsd += result?.totalCostUsd ?? 0;
      target.tokens += result?.totalTokens ?? 0;
      target.inputTokens += (result?.inputTokens ?? 0) + (result?.cacheCreationTokens ?? 0) + (result?.cacheReadTokens ?? 0);
    }

    return Array.from(trends.values())
      .map((trend) => toBudgetTrendRow(trend))
      .filter((trend) => trend.current.runs > 0 && (trend.previous.runs > 0 || trend.current.costUsd > 0 || trend.current.tokens > 0))
      .sort((a, b) => {
        const aWarn = a.severity === 'warn' ? 1 : 0;
        const bWarn = b.severity === 'warn' ? 1 : 0;
        return bWarn - aWarn || b.current.costUsd - a.current.costUsd || a.scope.localeCompare(b.scope);
      });
  }

  // Dequeue next pending job (returns null if none)
  dequeueNext(): AgentJob | null {
    const id = this.pendingIds.shift();
    if (!id) return null;
    const row = this.db
      .prepare(`SELECT data FROM jobs WHERE id=?`)
      .get(id) as { data: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.data) as AgentJob;
  }

  updateStatus(id: string, status: AgentJob['status'], extra?: Partial<AgentJob>): void {
    const row = this.db
      .prepare(`SELECT data FROM jobs WHERE id=?`)
      .get(id) as { data: string };
    if (!row) return;
    const job: AgentJob = { ...JSON.parse(row.data), status, ...extra };
    this.db
      .prepare(`UPDATE jobs SET data=?, status=?, updated_at=? WHERE id=?`)
      .run(JSON.stringify(job), status, new Date().toISOString(), id);
    if ((status === 'done' || status === 'failed') && job.result) {
      // Notify waiters
      const waitList = this.waiters.get(id);
      if (waitList) {
        for (const resolve of waitList) resolve(job.result);
        this.waiters.delete(id);
      }
    }
  }

  getJob(id: string): AgentJob | null {
    const row = this.db
      .prepare(`SELECT data FROM jobs WHERE id=?`)
      .get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as AgentJob) : null;
  }

  listJobs(filter?: { status?: string; parentJobId?: string; limit?: number; offset?: number }): AgentJob[] {
    let sql = `SELECT data FROM jobs`;
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (filter?.status) {
      clauses.push(`status=?`);
      params.push(filter.status);
    }
    if (filter?.parentJobId) {
      clauses.push(`parent_job_id=?`);
      params.push(filter.parentJobId);
    }
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ` ORDER BY created_at DESC`;
    if (filter?.limit) {
      sql += ` LIMIT ?`;
      params.push(filter.limit);
    }
    if (filter?.offset) {
      sql += ` OFFSET ?`;
      params.push(filter.offset);
    }
    return (this.db.prepare(sql).all(...params) as { data: string }[]).map(
      (r) => JSON.parse(r.data) as AgentJob
    );
  }

  // Wait for a job to complete. Returns the result when done/failed.
  waitForJob(
    id: string,
    timeoutMs: number
  ): Promise<JobResult & { timedOut?: boolean }> {
    const job = this.getJob(id);
    if (job?.status === 'done' || job?.status === 'failed') {
      return Promise.resolve({
        ...(job.result ?? {
          ok: false,
          error: 'no result',
          postedMessageIds: [],
          cardFiles: [],
          childJobIds: [],
        }),
      });
    }
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve({
            ok: false,
            timedOut: true,
            postedMessageIds: [],
            cardFiles: [],
            childJobIds: [],
          });
        }
      }, timeoutMs);
      list.push((result) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(result);
        }
      });
      this.waiters.set(id, list);
    });
  }

  // Card IDs table
  registerCardId(cardId: string, jobId: string, cardFile: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO card_ids (card_id, job_id, card_file, created_at) VALUES (?, ?, ?, ?)`
      )
      .run(cardId, jobId, cardFile, new Date().toISOString());
  }

  resolveCardId(cardId: string): { jobId: string; cardFile: string } | null {
    const row = this.db
      .prepare(`SELECT job_id, card_file FROM card_ids WHERE card_id=?`)
      .get(cardId) as { job_id: string; card_file: string } | undefined;
    return row ? { jobId: row.job_id, cardFile: row.card_file } : null;
  }

  updateCardFile(cardId: string, newFile: string): void {
    this.db
      .prepare(`UPDATE card_ids SET card_file=? WHERE card_id=?`)
      .run(newFile, cardId);
  }

  removePending(id: string): void {
    const idx = this.pendingIds.indexOf(id);
    if (idx !== -1) this.pendingIds.splice(idx, 1);
  }

  getSessionJobs(sessionId: string): AgentJob[] {
    return (
      this.db
        .prepare(
          `SELECT data FROM jobs WHERE json_extract(data, '$.sessionId') = ? AND status IN ('done', 'failed') ORDER BY created_at ASC`
        )
        .all(sessionId) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as AgentJob);
  }

  getAgentStats(since?: string): Array<{
    name: string;
    type: 'agent' | 'workflow' | 'direct';
    jobCount: number;
    doneCount: number;
    failedCount: number;
    totalCostUsd: number;
    totalTokens: number;
    totalDurationMs: number;
    totalToolCalls: number;
    totalOutputChars: number;
    lowOutputCount: number;
    efficiencyHintCount: number;
    warnHintCount: number;
    oversizedToolsetCount: number;
    unusedAllowedToolCount: number;
    lowValueStepCount: number;
    repeatedStepCount: number;
  }> {
    let sql = `SELECT data, status FROM jobs WHERE parent_job_id IS NULL`;
    const params: unknown[] = [];
    if (since) {
      sql += ` AND created_at >= ?`;
      params.push(since);
    }
    sql += ` ORDER BY created_at DESC`;

    const stats = new Map<string, {
      name: string;
      type: 'agent' | 'workflow' | 'direct';
      jobCount: number;
      doneCount: number;
      failedCount: number;
      totalCostUsd: number;
      totalTokens: number;
      totalDurationMs: number;
      totalToolCalls: number;
      totalOutputChars: number;
      lowOutputCount: number;
      efficiencyHintCount: number;
      warnHintCount: number;
      oversizedToolsetCount: number;
      unusedAllowedToolCount: number;
      lowValueStepCount: number;
      repeatedStepCount: number;
    }>();

    const rows = this.db.prepare(sql).all(...params) as { data: string; status: AgentJob['status'] }[];
    for (const row of rows) {
      const job = JSON.parse(row.data) as AgentJob;
      const name = job.agent ?? job.workflow ?? '(direct)';
      const type: 'agent' | 'workflow' | 'direct' = job.agent ? 'agent' : job.workflow ? 'workflow' : 'direct';
      const key = `${type}:${name}`;
      const result = job.result;
      const item = stats.get(key) ?? {
        name,
        type,
        jobCount: 0,
        doneCount: 0,
        failedCount: 0,
        totalCostUsd: 0,
        totalTokens: 0,
        totalDurationMs: 0,
        totalToolCalls: 0,
        totalOutputChars: 0,
        lowOutputCount: 0,
        efficiencyHintCount: 0,
        warnHintCount: 0,
        oversizedToolsetCount: 0,
        unusedAllowedToolCount: 0,
        lowValueStepCount: 0,
        repeatedStepCount: 0,
      };

      item.jobCount += 1;
      if (row.status === 'done') item.doneCount += 1;
      if (row.status === 'failed') item.failedCount += 1;
      item.totalCostUsd += result?.totalCostUsd ?? 0;
      item.totalTokens += result?.totalTokens ?? 0;
      item.totalDurationMs += result?.durationMs ?? 0;
      item.totalToolCalls += result?.toolCallCount ?? 0;
      item.totalOutputChars += result?.outputChars ?? result?.textOutput?.length ?? 0;

      const jobHints = result?.efficiencyHints ?? [];
      item.efficiencyHintCount += jobHints.length;
      item.warnHintCount += jobHints.filter((hint) => hint.severity === 'warn').length;
      if (jobHints.some((hint) => hint.type === 'toolset')) item.oversizedToolsetCount += 1;

      const unusedAllowedTools = result?.unusedAllowedTools ?? [];
      item.unusedAllowedToolCount += unusedAllowedTools.length;
      if (unusedAllowedTools.length >= 8 && (result?.toolsUsed?.length ?? 0) <= 3) item.oversizedToolsetCount += 1;

      const outputChars = result?.outputChars ?? result?.textOutput?.length ?? 0;
      if (
        row.status === 'done' &&
        outputChars < 80 &&
        (result?.cardFiles?.length ?? 0) === 0 &&
        (result?.postedMessageIds?.length ?? 0) === 0 &&
        (result?.childJobIds?.length ?? 0) === 0
      ) {
        item.lowOutputCount += 1;
      }

      const steps = result?.stepResults ?? [];
      for (const step of steps) {
        const stepHints = step.efficiencyHints ?? [];
        item.efficiencyHintCount += stepHints.length;
        item.warnHintCount += stepHints.filter((hint) => hint.severity === 'warn').length;
        if (stepHints.some((hint) => hint.type === 'merge_candidate' || hint.type === 'empty_output')) {
          item.lowValueStepCount += 1;
        }
        if (step.status === 'done' && (step.outputChars ?? step.textOutput?.length ?? 0) < 80 && step.type !== 'approval') {
          item.lowValueStepCount += 1;
        }
      }
      for (let i = 1; i < steps.length; i++) {
        const previous = steps[i - 1]!;
        const current = steps[i]!;
        if (previous.type === current.type && previous.label && previous.label === current.label) {
          item.repeatedStepCount += 1;
        }
      }

      stats.set(key, item);
    }

    return Array.from(stats.values()).sort((a, b) => b.totalCostUsd - a.totalCostUsd || b.failedCount - a.failedCount || a.name.localeCompare(b.name));
  }

  hasPendingJobs(): boolean {
    return this.pendingIds.length > 0;
  }

  getPendingCount(): number {
    return this.pendingIds.length;
  }

  createApproval(input: {
    workflowJobId: string;
    stepIndex: number;
    prompt: string;
    outputChannel?: { platform: string; id: string };
    threadId?: string;
  }): ApprovalRequest {
    const id = randomUUID();
    const now = new Date().toISOString();
    const approval: ApprovalRequest = {
      id,
      workflowJobId: input.workflowJobId,
      stepIndex: input.stepIndex,
      prompt: input.prompt,
      status: 'pending',
      outputChannel: input.outputChannel,
      threadId: input.threadId,
      createdAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO approval_requests (id, data, status, workflow_job_id, step_index, created_at) VALUES (?, ?, 'pending', ?, ?, ?)`
      )
      .run(id, JSON.stringify(approval), input.workflowJobId, input.stepIndex, now);
    return approval;
  }

  getApproval(id: string): ApprovalRequest | null {
    const row = this.db
      .prepare(`SELECT data FROM approval_requests WHERE id=?`)
      .get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ApprovalRequest) : null;
  }

  listApprovals(filter?: { status?: ApprovalStatus; limit?: number }): ApprovalRequest[] {
    let sql = `SELECT data FROM approval_requests`;
    const params: unknown[] = [];
    if (filter?.status) {
      sql += ` WHERE status=?`;
      params.push(filter.status);
    }
    sql += ` ORDER BY created_at DESC`;
    if (filter?.limit) {
      sql += ` LIMIT ?`;
      params.push(filter.limit);
    }
    return (this.db.prepare(sql).all(...params) as { data: string }[]).map(
      (r) => JSON.parse(r.data) as ApprovalRequest
    );
  }

  resolveApproval(
    id: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    details?: { resolvedBy?: string; comment?: string }
  ): ApprovalRequest | null {
    const existing = this.getApproval(id);
    if (!existing || existing.status !== 'pending') return existing;

    const resolvedAt = new Date().toISOString();
    const approval: ApprovalRequest = {
      ...existing,
      status,
      resolvedAt,
      resolvedBy: details?.resolvedBy,
      comment: details?.comment,
    };

    this.db
      .prepare(`UPDATE approval_requests SET data=?, status=?, resolved_at=? WHERE id=?`)
      .run(JSON.stringify(approval), status, resolvedAt, id);

    const waitList = this.approvalWaiters.get(id);
    if (waitList) {
      for (const resolve of waitList) resolve(approval);
      this.approvalWaiters.delete(id);
    }

    return approval;
  }

  waitForApproval(id: string, timeoutMs: number): Promise<ApprovalRequest> {
    const approval = this.getApproval(id);
    if (!approval) {
      return Promise.reject(new Error(`Approval not found: ${id}`));
    }
    if (approval.status !== 'pending') {
      return Promise.resolve(approval);
    }

    return new Promise((resolve) => {
      const list = this.approvalWaiters.get(id) ?? [];
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const timedOut = this.resolveApproval(id, 'timed_out') ?? approval;
          resolve(timedOut);
        }
      }, timeoutMs);

      list.push((result) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(result);
        }
      });
      this.approvalWaiters.set(id, list);
    });
  }
}

function emptyTrendMetrics(): BudgetTrendMetrics {
  return { runs: 0, costUsd: 0, tokens: 0, inputTokens: 0 };
}

function toBudgetTrendRow(trend: {
  name: string;
  type: 'agent' | 'workflow' | 'direct';
  current: BudgetTrendMetrics;
  previous: BudgetTrendMetrics;
}): BudgetTrendRow {
  const current = withAverages(trend.current);
  const previous = withAverages(trend.previous);
  const costChangePct = percentChange(current.costUsd, previous.costUsd);
  const avgCostChangePct = percentChange(current.avgCostUsd, previous.avgCostUsd);
  const avgTokensChangePct = percentChange(current.avgTokens, previous.avgTokens);
  const avgInputTokensChangePct = percentChange(current.avgInputTokens, previous.avgInputTokens);
  const reasons: string[] = [];
  if (avgCostChangePct !== null && avgCostChangePct >= 40) {
    reasons.push(`Avg run cost is up ${Math.round(avgCostChangePct)}% this week.`);
  }
  if (avgInputTokensChangePct !== null && avgInputTokensChangePct >= 40) {
    reasons.push(`Prompt/input tokens are up ${Math.round(avgInputTokensChangePct)}% this week.`);
  }
  if (costChangePct !== null && costChangePct >= 40 && current.costUsd >= 0.1) {
    reasons.push(`Total spend is up ${Math.round(costChangePct)}% this week.`);
  }
  return {
    scope: `${trend.type}: ${trend.name}`,
    name: trend.name,
    type: trend.type,
    current,
    previous,
    costChangePct,
    avgCostChangePct,
    avgTokensChangePct,
    avgInputTokensChangePct,
    severity: reasons.length ? 'warn' : 'info',
    reasons,
  };
}

function withAverages(metrics: BudgetTrendMetrics): BudgetTrendMetrics & {
  avgCostUsd: number;
  avgTokens: number;
  avgInputTokens: number;
} {
  return {
    ...metrics,
    avgCostUsd: metrics.runs ? metrics.costUsd / metrics.runs : 0,
    avgTokens: metrics.runs ? metrics.tokens / metrics.runs : 0,
    avgInputTokens: metrics.runs ? metrics.inputTokens / metrics.runs : 0,
  };
}

function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}
