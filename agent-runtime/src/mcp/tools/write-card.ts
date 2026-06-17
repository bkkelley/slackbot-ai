import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { JobQueue } from '../../job-queue.js';
import { Logger } from '../../logger.js';
import { createRequire } from 'module';

const logger = new Logger('write-card');
const require = createRequire(import.meta.url);
const { assertSafeSegment, safeJoin } = require('../../../../shared/path-guard.js');
const VAULT_PATH = process.env.VAULT_PATH || `${process.env.HOME}/claude-workspaces/admin`;

export interface WriteCardInput {
  yaml: string;
  content?: string;
}

export interface WriteCardResult {
  ok: boolean;
  cardId?: string;
  cardFile?: string;
  error?: string;
}

function nowTimestamp(): string {
  const d = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds()) +
    pad(d.getMilliseconds(), 3)
  );
}

export function writeCardTool(
  jobId: string,
  input: WriteCardInput,
  queue: JobQueue
): WriteCardResult {
  try {
    const job = queue.getJob(jobId);
    const agentName = assertSafeSegment(job?.agent ?? 'Agent', 'agent name');
    const actionName = assertSafeSegment(job?.action ?? 'Run', 'action name');

    const ts = nowTimestamp();
    const now = new Date().toISOString();
    const dateStr = now.slice(0, 10);
    const timeStr = now.slice(11, 16).replace(':', '');
    const filename = `${agentName} - ${actionName} - ${dateStr} ${timeStr}.md`;
    const cardDir = safeJoin(VAULT_PATH, 'Card');
    const filePath = safeJoin(cardDir, filename);

    const cardId = randomUUID();
    const body = input.content ? `\n${input.content}` : '';
    const fileContent =
      `---\nfileClass: Card\nfavorite: false\narchived: false\ntags:\n  - cards\ncreated: ${ts}\nmodified: ${ts}\n` +
      `${input.yaml.trim()}\n---${body}`;

    fs.mkdirSync(cardDir, { recursive: true });
    fs.writeFileSync(filePath, fileContent, 'utf8');

    queue.registerCardId(cardId, jobId, filename);
    logger.info('Card written', { cardId, filename, jobId });

    return { ok: true, cardId, cardFile: filename };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to write card', { error: msg, jobId });
    return { ok: false, error: msg };
  }
}
