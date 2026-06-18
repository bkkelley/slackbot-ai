/**
 * Optional long-term memory via MemPalace (https://github.com/mempalace/mempalace).
 *
 * OPT-IN: every function no-ops unless MEMORY_ENABLED=true, and the CLI call fails soft
 * (returns []) so the bot behaves identically when memory isn't installed/enabled.
 *
 * MemPalace is local + offline (local embeddings, no API key). Memory is populated by
 * `mempalace mine` (a scheduled job indexes the workspaces + Claude session transcripts);
 * here we only RECALL via `mempalace search`, which we shell out to and parse.
 */

import { execFile } from 'child_process';

const MEM_BIN = process.env.MEMPALACE_BIN || `${process.env.HOME}/.local/bin/mempalace`;

export function memoryEnabled(): boolean {
  return process.env.MEMORY_ENABLED === 'true';
}

function run(args: string[], timeoutMs = 6000): Promise<string> {
  return new Promise((resolve) => {
    execFile(MEM_BIN, args, { timeout: timeoutMs, env: process.env, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

// MemPalace `search` prints human-readable blocks separated by a line of box-drawing dashes.
// Strip the decoration lines ([n], Source:, Match:, headers, rules) and keep the content.
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

/** Recall relevant memory. Returns [] when disabled, not installed, or on any error. */
export async function recall(query: string, limit = 5): Promise<string[]> {
  if (!memoryEnabled() || !query?.trim()) return [];
  const out = await run(['search', query.trim().slice(0, 300), '--results', String(limit)]);
  return parseSearch(out).slice(0, limit);
}

/** Build a prompt preamble from recall snippets (empty string if none). */
export function recallPreamble(snippets: string[]): string {
  if (!snippets.length) return '';
  const lines = snippets.map((s) => `- ${s}`).join('\n');
  return `[Relevant memory — recalled from your notes and past sessions. Use if relevant to this request; ignore if not.]\n${lines}\n\n`;
}
