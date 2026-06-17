import { Logger } from '../../logger.js';

const logger = new Logger('transport-proxy');

const BOT_HTTP_PORT = process.env.BOT_HTTP_PORT || '3458';
const BOT_RUNTIME_SHARED_SECRET = process.env.BOT_RUNTIME_SHARED_SECRET || '';

export interface ProxyResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * POST a payload to one of the bot's transport-proxy endpoints. Shared by the Slack-native
 * agent tools (canvas, scheduled message, reminder). Mirrors the call pattern in post-message.ts.
 */
export async function callTransportProxy(
  path: string,
  payload: Record<string, unknown>
): Promise<ProxyResult> {
  try {
    const resp = await fetch(`http://127.0.0.1:${BOT_HTTP_PORT}/api/transport-proxy/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Auth': BOT_RUNTIME_SHARED_SECRET,
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const text = await resp.text();
      logger.warn('Bot transport-proxy returned error', { path, status: resp.status, body: text.slice(0, 200) });
      return { ok: false, error: `Bot returned ${resp.status}: ${text.slice(0, 200)}` };
    }

    return (await resp.json()) as ProxyResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Bot unreachable', { path, error: msg });
    return { ok: false, error: `bot unreachable: ${msg}` };
  }
}
