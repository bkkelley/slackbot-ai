/**
 * Optional long-term memory via MemPalace for agent jobs (local, offline, no API key).
 *
 * OPT-IN: no-ops unless MEMORY_ENABLED=true; the CLI call fails soft so agents run
 * identically when memory isn't installed/enabled. Recall only (ingestion is a separate
 * scheduled `mempalace mine`).
 */

import { execFile } from 'child_process';
import { AgentJob } from './types.js';

const MEM_BIN = process.env.MEMPALACE_BIN || `${process.env.HOME}/.local/bin/mempalace`;

export function memoryEnabled(): boolean {
  return process.env.MEMORY_ENABLED === 'true';
}

/** Derive a recall query from a job (agent + action + reply + workflow context). */
export function buildQuery(job: AgentJob): string {
  const parts = [job.agent, job.action, job.replyText, job.workflowContext]
    .filter(Boolean)
    .map((p) => String(p).trim())
    .filter(Boolean);
  return (parts.join(' ') || job.prompt || '').slice(0, 300);
}

function run(args: string[], timeoutMs = 6000): Promise<string> {
  return new Promise((resolve) => {
    execFile(MEM_BIN, args, { timeout: timeoutMs, env: process.env, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

function parseSearch(stdout: string): string[] {
  const snippets: string[] = [];
  for (const block of stdout.split(/[─-]{5,}/)) {
    const text = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) =>
        l &&
        !/^\[\d+\]/.test(l) &&
        !/^Source:/i.test(l) &&
        !/^Match:/i.test(l) &&
        !/^Results for:/i.test(l) &&
        !/^=+$/.test(l))
      .join(' ')
      .trim();
    if (text) snippets.push(text.slice(0, 600));
  }
  return snippets;
}

export async function recall(query: string, limit = 5): Promise<string[]> {
  if (!memoryEnabled() || !query?.trim()) return [];
  const out = await run(['search', query.trim().slice(0, 300), '--results', String(limit)]);
  return parseSearch(out).slice(0, limit);
}
