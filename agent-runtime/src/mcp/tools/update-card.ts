import * as fs from 'fs';
import * as path from 'path';
import { JobQueue } from '../../job-queue.js';
import { Logger } from '../../logger.js';

const logger = new Logger('update-card');
const VAULT_PATH = process.env.VAULT_PATH || `${process.env.HOME}/claude-workspaces/global`;

export interface UpdateCardInput {
  cardId: string;
  yaml: string;
  content?: string;
}

export interface UpdateCardResult {
  ok: boolean;
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

export function updateCardTool(
  jobId: string,
  input: UpdateCardInput,
  queue: JobQueue
): UpdateCardResult {
  const resolved = queue.resolveCardId(input.cardId);
  if (!resolved) {
    return { ok: false, error: `Card ID not found: ${input.cardId}` };
  }

  const filePath = path.join(VAULT_PATH, 'Card', resolved.cardFile);
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: `Card file not found: ${resolved.cardFile}` };
  }

  try {
    const ts = nowTimestamp();
    const body = input.content ? `\n${input.content}` : '';
    // Preserve created timestamp from original; update modified
    let existing = '';
    try {
      existing = fs.readFileSync(filePath, 'utf8');
    } catch {}
    const createdMatch = existing.match(/^created:\s*(.+)$/m);
    const createdVal = createdMatch ? createdMatch[1].trim() : ts;

    const fileContent =
      `---\nfileClass: Card\nfavorite: false\narchived: false\ntags:\n  - cards\ncreated: ${createdVal}\nmodified: ${ts}\n` +
      `${input.yaml.trim()}\n---${body}`;

    fs.writeFileSync(filePath, fileContent, 'utf8');
    logger.info('Card updated', { cardId: input.cardId, cardFile: resolved.cardFile, jobId });

    return { ok: true, cardFile: resolved.cardFile };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to update card', { error: msg, cardId: input.cardId });
    return { ok: false, error: msg };
  }
}
