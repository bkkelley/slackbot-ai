import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { AgentJob } from './types.js';

const SLACK_MCP_CONFIG_PATH = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), '..', 'slack-bot', 'mcp-servers.json');

export interface MemoryOptions {
  query?: string;
  topK?: number;
}

export interface MemoryInspection {
  backend: string;
  configured: boolean;
  available: boolean;
  configPath: string;
  command: string | null;
  query: string;
  topK: number;
  stats: Record<string, unknown> | null;
  recall: {
    ok: boolean;
    resultCount: number;
    raw: string;
    chars: number;
    error: string | null;
  };
  sources: Array<{
    source: string;
    label: string;
    included: boolean;
    chars: number;
    reason: string;
    provenance?: string;
  }>;
}

export function buildMemoryQuery(job: AgentJob, override?: string): string {
  if (override?.trim()) return override.trim().slice(0, 500);
  const parts = [
    job.agent,
    job.action,
    job.workflow ? `workflow ${job.workflow}` : undefined,
    job.scope,
    job.replyText,
  ].filter(Boolean).map((part) => String(part).trim()).filter(Boolean);
  return parts.join(' ').slice(0, 500) || job.prompt?.slice(0, 500) || job.id;
}

export function inspectMnemosyneMemory(job: AgentJob, options: MemoryOptions = {}): MemoryInspection {
  const mcpServers = readMcpServerConfig(SLACK_MCP_CONFIG_PATH);
  const mnemosyneConfig = mcpServers['mnemosyne'] && typeof mcpServers['mnemosyne'] === 'object'
    ? mcpServerRecord(mcpServers['mnemosyne'])
    : null;
  const command = String(process.env.MNEMOSYNE_BIN || mnemosyneConfig?.['command'] || `${process.env.HOME}/.local/bin/mnemosyne`);
  const configured = Boolean(mnemosyneConfig);
  const available = fs.existsSync(command);
  const query = buildMemoryQuery(job, options.query);
  const topK = clampInteger(options.topK, 1, 20, 5);
  const stats = available ? readMnemosyneStats(command) : null;
  const recall = available
    ? readMnemosyneRecall(command, query, topK)
    : {
        ok: false,
        resultCount: 0,
        raw: '',
        chars: 0,
        error: `Mnemosyne binary not found: ${command}`,
      };
  const hasRecallHits = recall.ok && recall.resultCount > 0;

  return {
    backend: 'mnemosyne',
    configured,
    available,
    configPath: SLACK_MCP_CONFIG_PATH,
    command: available ? command : null,
    query,
    topK,
    stats,
    recall,
    sources: [
      {
        source: 'mnemosyne',
        label: 'Ori Mnemos / Mnemosyne recall',
        included: hasRecallHits,
        chars: recall.chars,
        reason: configured ? 'Registered in slack-bot MCP config' : 'Not registered in slack-bot MCP config',
        provenance: stats?.['dbPath'] ? String(stats['dbPath']) : undefined,
      },
    ],
  };
}

function readMcpServerConfig(configPath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    if (config.mcpServers && typeof config.mcpServers === 'object') {
      return config.mcpServers as Record<string, unknown>;
    }
  } catch { /* missing or invalid MCP config is fine for inspection */ }
  return {};
}

function mcpServerRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readMnemosyneStats(command: string): Record<string, unknown> | null {
  const result = runMnemosyne(command, ['stats']);
  if (!result.ok) return { error: result.error, raw: result.stdout };
  const raw = result.stdout;
  return {
    totalMemories: readStatsNumber(raw, /Total memories:\s*(\d+)/i),
    workingMemory: readStatsNumber(raw, /Working memory:\s*(\d+)/i),
    episodicMemory: readStatsNumber(raw, /Episodic memory:\s*(\d+)/i),
    knowledgeTriples: readStatsNumber(raw, /Knowledge triples:\s*(\d+)/i),
    banks: readStatsText(raw, /Banks:\s*(.+)/i),
    dbPath: readStatsText(raw, /DB path:\s*(.+)/i),
    raw,
  };
}

function readMnemosyneRecall(command: string, query: string, topK: number): MemoryInspection['recall'] {
  const result = runMnemosyne(command, ['recall', query, String(topK)]);
  const raw = result.stdout.trim();
  const text = recallText(raw);
  return {
    ok: result.ok,
    resultCount: text ? Math.max(1, (text.match(/\n\s*ID:\s+/g) || []).length || 1) : 0,
    raw,
    chars: text.length,
    error: result.error,
  };
}

function recallText(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith('Results for:'))
    .join('\n')
    .trim();
}

function runMnemosyne(command: string, args: string[]): { ok: boolean; stdout: string; error: string | null } {
  try {
    const stdout = execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 256 * 1024,
    });
    return { ok: true, stdout, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const stdout = typeof (err as { stdout?: unknown }).stdout === 'string' ? (err as { stdout: string }).stdout : '';
    return { ok: false, stdout, error };
  }
}

function readStatsNumber(raw: string, pattern: RegExp): number | null {
  const match = raw.match(pattern);
  return match ? Number(match[1]) : null;
}

function readStatsText(raw: string, pattern: RegExp): string | null {
  const match = raw.match(pattern);
  return match ? match[1]!.trim() : null;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}
