/**
 * Optional Supermemory integration (self-hosted, offline-capable memory + recall).
 *
 * This is an OPT-IN feature. Every function no-ops unless SUPERMEMORY_ENABLED=true,
 * and all network calls fail soft (return [] / false) so the bot behaves identically
 * when the memory server isn't installed or isn't running.
 *
 *   recall(query)        → POST /v3/search   — semantic search over stored content (chunks)
 *   remember(content)    → POST /v3/documents — store text for later recall
 *
 * Recall uses /v3/search (document-chunk search) rather than /v4/search (extracted
 * "memories"), because chunk search returns stored content by similarity even when the
 * extraction model produces no distilled memories.
 */

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

export interface RecallHit { content: string; score: number; }

/** Semantic recall. Returns [] when disabled, unreachable, or on any error. */
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

/** Store text. Fire-and-forget friendly; returns false when disabled/unreachable. */
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

/** Build a prompt preamble from recall hits (empty string if none). */
export function recallPreamble(hits: RecallHit[]): string {
  if (!hits.length) return '';
  const lines = hits.map((h) => `- ${h.content}`).join('\n');
  return `[Relevant memory — facts recalled from earlier that may help with this request. Use if relevant; ignore if not.]\n${lines}\n\n`;
}

/**
 * Decide whether a user message is worth auto-storing. Skips short messages, bot
 * commands ($..., mcp), and pure questions so the store fills with durable signal.
 */
export function worthRemembering(text: string): boolean {
  const t = (text || '').trim();
  if (t.length < 15) return false;
  if (/^\$/.test(t) || /^mcp\b/i.test(t)) return false;
  return true;
}
