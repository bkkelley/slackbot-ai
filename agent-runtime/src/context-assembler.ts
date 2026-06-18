import * as fs from 'fs';
import * as path from 'path';
import { AgentJob } from './types.js';
import { Logger } from './logger.js';
import { createRequire } from 'module';
import { memoryEnabled, recall, buildQuery } from './memory.js';

const VAULT_PATH = process.env.VAULT_PATH || `${process.env.HOME}/claude-workspaces/admin`;
const BASE_DIRECTORY = process.env.BASE_DIRECTORY || `${process.env.HOME}/claude-workspaces`;

const logger = new Logger('context-assembler');
const require = createRequire(import.meta.url);
const { assertSafeSegment, optionalScope, safeJoin, safeMarkdownFile } = require('../../shared/path-guard.js');
const { resolveActionFilePath } = require('../../shared/action-resolver.js');
const { resolvePersonaFilePath } = require('../../shared/persona-resolver.js');

// --- File helpers ---

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function findMarkdownFile(dir: string, name: string): string | null {
  try {
    const expected = `${name}.md`.toLowerCase();
    const match = fs.readdirSync(dir).find((file) => file.toLowerCase() === expected);
    return match ? path.join(dir, match) : null;
  } catch {
    const exactPath = safeMarkdownFile(dir, name, 'markdown filename');
    return fs.existsSync(exactPath) ? exactPath : null;
  }
}

function resolveAgentFilePath(agentName: string, safeScope: string | null): string | null {
  const projectAgentPath = safeScope
    ? findMarkdownFile(safeJoin(BASE_DIRECTORY, safeScope, '.claude', 'agents'), agentName)
      ?? findMarkdownFile(safeJoin(BASE_DIRECTORY, safeScope, '.agents'), agentName)
    : null;
  if (projectAgentPath) return projectAgentPath;

  return (
    findMarkdownFile(path.join(process.env.HOME ?? '', '.claude', 'agents'), agentName) ??
    findMarkdownFile(safeJoin(BASE_DIRECTORY, '.claude:agents'), agentName) ??
    findMarkdownFile(safeJoin(VAULT_PATH, 'Agent'), agentName)
  );
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line
      .slice(colonIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key) fm[key] = val;
  }
  return fm;
}

function extractWikilink(val: string | undefined): string | null {
  if (!val) return null;
  const m = val.match(/\[\[([^\]]+)\]\]/);
  return m ? m[1] : val;
}

// --- Card queries ---

interface CardEntry {
  filename: string;
  content: string;
  mtime: Date;
}

function getRecentCards(
  type: 'agent-log' | 'pattern',
  agentWikilink: string | null,
  days: number
): CardEntry[] {
  const cardDir = path.join(VAULT_PATH, 'Card');
  if (!fs.existsSync(cardDir)) return [];

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const results: CardEntry[] = [];

  let filenames: string[];
  try {
    filenames = fs.readdirSync(cardDir);
  } catch (err) {
    logger.warn('Could not scan card directory — running without recent cards', {
      cardDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  for (const filename of filenames) {
    if (!filename.endsWith('.md')) continue;
    const filePath = path.join(cardDir, filename);
    let content: string;
    try {
      content = readFile(filePath);
    } catch {
      continue;
    }
    const fm = parseFrontmatter(content);
    const mtime = fs.statSync(filePath).mtime;
    if (mtime < cutoff) continue;

    if (type === 'agent-log') {
      if (fm['card-type'] !== 'Agent Log') continue;
      if (!fm['agent'] || !agentWikilink || !fm['agent'].includes(agentWikilink)) continue;
    } else if (type === 'pattern') {
      if (fm['card-type'] !== 'Agent Pattern') continue;
      if (!fm['agent'] || !agentWikilink || !fm['agent'].includes(agentWikilink)) continue;
      if (fm['pattern-status'] === 'RETIRED') continue;
    }

    results.push({ filename, content, mtime });
  }

  results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return results;
}

function formatCards(cards: CardEntry[]): string {
  if (cards.length === 0) return '(none)';
  return cards.map((c) => `--- ${c.filename} ---\n${c.content}`).join('\n\n');
}

// --- Check-in history ---

interface SessionHistoryEntry {
  role: string;
  text: string;
}

function buildCheckinHistorySection(
  history: SessionHistoryEntry[],
  currentTurn: number
): string {
  if (!history || history.length === 0) return '';
  const lines = history.map(
    (h) => `${h.role === 'sage' ? 'Sage' : 'User'}: ${h.text}`
  );
  return [
    '',
    `=== CHECK-IN CONVERSATION (you are on turn ${currentTurn} of 4) ===`,
    lines.join('\n'),
    '',
    `You are on turn ${currentTurn}. Follow the instructions in the action template for turn ${currentTurn}.`,
  ].join('\n');
}

// --- Main assembly ---

export interface AssemblePromptOpts {
  sessionHistory?: SessionHistoryEntry[];
}

export async function assemblePrompt(job: AgentJob, opts?: AssemblePromptOpts): Promise<string> {
  // Raw prompt — return directly
  if (job.prompt) return job.prompt;

  const agentName = job.agent;
  const actionName = job.action;

  if (!agentName) {
    throw new Error('Job has neither prompt nor agent set');
  }

  const safeAgent = assertSafeSegment(agentName, 'agent name');
  const safeScope = optionalScope(job.scope);
  const agentFilePath = resolveAgentFilePath(safeAgent, safeScope);
  if (!agentFilePath) {
    const searched = [
      safeScope ? safeJoin(BASE_DIRECTORY, safeScope, '.claude', 'agents') : null,
      safeScope ? safeJoin(BASE_DIRECTORY, safeScope, '.agents') : null,
      path.join(process.env.HOME ?? '', '.claude', 'agents'),
      safeJoin(BASE_DIRECTORY, '.claude:agents'),
      safeJoin(VAULT_PATH, 'Agent'),
    ].filter(Boolean).join(', ');
    throw new Error(`Agent file not found for "${agentName}" in: ${searched}`);
  }

  const agentContent = readFile(agentFilePath);
  const agentFm = parseFrontmatter(agentContent);
  const personaName = extractWikilink(agentFm['persona']);

  // Persona — project scope first, fall back to vault
  let personaContent = '';
  if (personaName) {
    try {
      const personaFilePath = resolvePersonaFilePath(personaName, safeScope);
      if (!personaFilePath) {
        logger.warn('Persona file not found — running without persona', { personaName, scope: safeScope });
      } else {
        personaContent = readFile(personaFilePath);
      }
    } catch (err) {
      logger.warn('Invalid persona reference — running without persona', {
        personaName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Action template
  let actionContent = '';
  if (actionName) {
    const safeAction = assertSafeSegment(actionName, 'action name');
    const actionFilePath = resolveActionFilePath(safeAgent, safeAction, safeScope);
    if (actionFilePath) {
      actionContent = readFile(actionFilePath);
    } else {
      logger.warn('Action template not found — running without action context', {
        agentName,
        actionName,
      });
    }
  }

  // Recent cards
  const agentLogs = getRecentCards('agent-log', agentName, 14).slice(0, 14);
  const patterns = getRecentCards('pattern', agentName, 9999);

  // Session / check-in history (pre-fetched from SQLite by executor)
  let historySection = '';
  if (job.sessionId && opts?.sessionHistory && opts.sessionHistory.length > 0) {
    const sageTurns = opts.sessionHistory.filter((h) => h.role === 'sage').length;
    const currentTurn = sageTurns + 1;
    historySection = buildCheckinHistorySection(opts.sessionHistory, currentTurn);
  }

  const replyTextForPrompt = job.replyText ?? null;

  // Assemble — same order as agent-dispatcher.js
  const today = new Date().toISOString().slice(0, 10);
  const parts: string[] = [];

  if (personaContent) {
    parts.push('=== PERSONA (voice, tone, constraints) ===', personaContent);
  }

  parts.push('=== AGENT (identity, knowledge, instructions) ===', agentContent);

  parts.push(
    '',
    '=== YOUR RECENT AGENT LOGS (last 14 days — do not repeat openings) ===',
    formatCards(agentLogs),
    '',
    '=== ACTIVE PATTERNS (your distilled long-term observations) ===',
    formatCards(patterns)
  );

  if (actionContent) {
    parts.push(
      '',
      "=== ACTION (what you're doing right now) ===",
      actionContent
    );
  }

  if (job.files && job.files.length > 0) {
    parts.push('', '=== FILES TO PROCESS ===', job.files.join('\n'));
  }

  if (job.workflowContext) parts.push('', '=== PRIOR STEP OUTPUT ===', job.workflowContext);
  if (replyTextForPrompt) parts.push('', "=== USER'S REPLY ===", replyTextForPrompt);
  if (historySection) parts.push(historySection);

  // Optional long-term memory recall (MemPalace). No-ops when disabled/not installed.
  if (memoryEnabled()) {
    const hits = await recall(buildQuery(job));
    if (hits.length) {
      parts.push('', '=== RELEVANT MEMORY (recalled long-term context; use if relevant) ===',
        hits.map((h) => `- ${h}`).join('\n'));
    }
  }

  parts.push('', "=== TODAY'S DATE ===", today);

  // Tool usage instructions (replaces old output-directive instructions)
  parts.push(
    '',
    '=== HOW TO OUTPUT RESULTS ===',
    'Do NOT write SLACK_MESSAGE:, AGENT_LOG_CARD:, or SPAWN_AGENT: in your output.',
    'Instead, use the tools available to you:',
    '- Call PostMessage to send a message to Slack',
    '- Call WriteCard to write an agent log card to the vault',
    '- Call SpawnAgent to spawn a child agent job',
    '- Call UpdateCard to update a card you already wrote this run',
    'You must call PostMessage and WriteCard — do not just output text.'
  );

  return parts.join('\n');
}
