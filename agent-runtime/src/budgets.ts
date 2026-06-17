import * as fs from 'fs';
import * as path from 'path';
import { AgentJob } from './types.js';

export interface BudgetLimit {
  maxCostUsd?: number;
  maxRuns?: number;
  maxTokens?: number;
}

export interface BudgetPolicy {
  enabled?: boolean;
  daily?: BudgetLimit;
  agents?: Record<string, BudgetLimit>;
  workflows?: Record<string, BudgetLimit>;
  toolsets?: Record<string, BudgetLimit>;
  triggers?: Record<string, BudgetLimit>;
}

export interface BudgetUsage {
  costUsd: number;
  runs: number;
  tokens: number;
}

export interface BudgetCheck {
  ok: boolean;
  reason?: string;
  scope?: string;
  limit?: BudgetLimit;
  usage?: BudgetUsage;
}

export type BudgetUsageReader = (
  sinceIso: string,
  filter?: {
    agent?: string;
    workflow?: string;
    toolset?: string;
    trigger?: AgentJob['trigger'];
  }
) => BudgetUsage;

const BUDGETS_PATH = process.env.BUDGETS_PATH || path.join(
  path.dirname(path.dirname(new URL(import.meta.url).pathname)),
  'budgets.json'
);

export function startOfLocalDayIso(now = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function loadBudgetPolicy(): BudgetPolicy {
  try {
    return JSON.parse(fs.readFileSync(BUDGETS_PATH, 'utf8')) as BudgetPolicy;
  } catch {
    return { enabled: false };
  }
}

export function saveBudgetPolicy(policy: BudgetPolicy): BudgetPolicy {
  const normalized = normalizeBudgetPolicy(policy);
  fs.mkdirSync(path.dirname(BUDGETS_PATH), { recursive: true });
  const tmpPath = `${BUDGETS_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, BUDGETS_PATH);
  return normalized;
}

export function checkBudget(
  job: Omit<AgentJob, 'id' | 'status' | 'createdAt'>,
  readUsage: BudgetUsageReader,
  policy = loadBudgetPolicy(),
  sinceIso = startOfLocalDayIso()
): BudgetCheck {
  if (!policy.enabled) return { ok: true };

  const checks: Array<{
    scope: string;
    limit?: BudgetLimit;
    filter?: Parameters<BudgetUsageReader>[1];
  }> = [
    { scope: 'daily', limit: policy.daily },
  ];

  if (job.agent) {
    checks.push({
      scope: `agent:${job.agent}`,
      limit: policy.agents?.[job.agent],
      filter: { agent: job.agent },
    });
  }
  if (job.workflow) {
    checks.push({
      scope: `workflow:${job.workflow}`,
      limit: policy.workflows?.[job.workflow],
      filter: { workflow: job.workflow },
    });
  }
  if (job.toolset) {
    checks.push({
      scope: `toolset:${job.toolset}`,
      limit: policy.toolsets?.[job.toolset],
      filter: { toolset: job.toolset },
    });
  }
  if (job.trigger) {
    checks.push({
      scope: `trigger:${job.trigger}`,
      limit: policy.triggers?.[job.trigger],
      filter: { trigger: job.trigger },
    });
  }

  for (const check of checks) {
    if (!check.limit) continue;
    const usage = readUsage(sinceIso, check.filter);
    const cadence = check.scope === 'daily' ? 'daily' : `${check.scope} daily`;
    if (typeof check.limit.maxCostUsd === 'number' && usage.costUsd >= check.limit.maxCostUsd) {
      return {
        ok: false,
        scope: check.scope,
        limit: check.limit,
        usage,
        reason: `${cadence} cost budget reached: $${usage.costUsd.toFixed(2)} / $${check.limit.maxCostUsd.toFixed(2)}`,
      };
    }
    if (typeof check.limit.maxRuns === 'number' && usage.runs >= check.limit.maxRuns) {
      return {
        ok: false,
        scope: check.scope,
        limit: check.limit,
        usage,
        reason: `${cadence} run budget reached: ${usage.runs} / ${check.limit.maxRuns}`,
      };
    }
    if (typeof check.limit.maxTokens === 'number' && usage.tokens >= check.limit.maxTokens) {
      return {
        ok: false,
        scope: check.scope,
        limit: check.limit,
        usage,
        reason: `${cadence} token budget reached: ${usage.tokens} / ${check.limit.maxTokens}`,
      };
    }
  }

  return { ok: true };
}

export function getBudgetPolicyPath(): string {
  return BUDGETS_PATH;
}

function normalizeBudgetPolicy(policy: BudgetPolicy): BudgetPolicy {
  const normalizeLimit = (limit?: BudgetLimit): BudgetLimit | undefined => {
    if (!limit || typeof limit !== 'object') return undefined;
    const normalized: BudgetLimit = {};
    const maxCostUsd = readNonNegativeNumber(limit.maxCostUsd);
    const maxRuns = readNonNegativeNumber(limit.maxRuns);
    const maxTokens = readNonNegativeNumber(limit.maxTokens);
    if (maxCostUsd !== undefined) normalized.maxCostUsd = maxCostUsd;
    if (maxRuns !== undefined) normalized.maxRuns = Math.floor(maxRuns);
    if (maxTokens !== undefined) normalized.maxTokens = Math.floor(maxTokens);
    return Object.keys(normalized).length ? normalized : {};
  };

  const normalizeLimits = (limits?: Record<string, BudgetLimit>): Record<string, BudgetLimit> => {
    const normalized: Record<string, BudgetLimit> = {};
    for (const [name, limit] of Object.entries(limits ?? {})) {
      const key = name.trim();
      if (!key) continue;
      const normalizedLimit = normalizeLimit(limit);
      if (normalizedLimit) normalized[key] = normalizedLimit;
    }
    return normalized;
  };

  return {
    enabled: policy.enabled !== false,
    daily: normalizeLimit(policy.daily) ?? {},
    agents: normalizeLimits(policy.agents),
    workflows: normalizeLimits(policy.workflows),
    toolsets: normalizeLimits(policy.toolsets),
    triggers: normalizeLimits(policy.triggers),
  };
}

function readNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}
