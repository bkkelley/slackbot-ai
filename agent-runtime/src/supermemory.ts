/**
 * Optional Supermemory integration for agent jobs (self-hosted, offline-capable).
 *
 * OPT-IN: every function no-ops unless SUPERMEMORY_ENABLED=true, and all network calls
 * fail soft so agents run identically when memory isn't installed/running.
 *
 *   recall(query) → POST /v3/search    — semantic search over stored content (chunks)
 *   remember(...) → POST /v3/documents — store text for later recall
 */

import { AgentJob } from './types.js';

const BASE = process.env.SUPERMEMORY_URL || 'http://localhost:6767';
const KEY = process.env.SUPERMEMORY_API_KEY || '';
const TIMEOUT_MS = 4000;

export function memoryEnabled(): boolean {
  return process.env.SUPERMEMORY_ENABLED === 'true';
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (KEY) h['Authorization'] = `Bearer ${KEY}`;
  return h;
}

/** Derive a recall query from a job (agent + action + reply + workflow context). */
export function buildQuery(job: AgentJob): string {
  const parts = [job.agent, job.action, job.replyText, job.workflowContext]
    .filter(Boolean)
    .map((p) => String(p).trim())
    .filter(Boolean);
  return (parts.join(' ') || job.prompt || '').slice(0, 500);
}

export interface RecallHit { content: string; score: number; }

export async function recall(query: string, limit = 5): Promise<RecallHit[]> {
  if (!memoryEnabled() || !query?.trim()) return [];
  try {
    const r = await fetch(`${BASE}/v3/search`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ q: query.trim().slice(0, 500) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return [];
    const data = (await r.json()) as { results?: Array<{ chunks?: Array<{ content?: string; score?: number; isRelevant?: boolean }> }> };
    const hits: RecallHit[] = [];
    for (const res of data.results || []) {
      for (const c of res.chunks || []) {
        if (c.content && (c.isRelevant ?? true)) hits.push({ content: c.content.trim(), score: c.score ?? 0 });
      }
    }
    const seen = new Set<string>();
    return hits
      .sort((a, b) => b.score - a.score)
      .filter((h) => (seen.has(h.content) ? false : seen.add(h.content)))
      .slice(0, limit);
  } catch {
    return [];
  }
}

export async function remember(content: string, metadata?: Record<string, unknown>): Promise<boolean> {
  if (!memoryEnabled() || !content?.trim()) return false;
  try {
    const r = await fetch(`${BASE}/v3/documents`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ content: content.trim().slice(0, 8000), metadata: metadata || {} }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return r.ok;
  } catch {
    return false;
  }
}
