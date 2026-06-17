import { callTransportProxy } from './transport-proxy.js';

export interface WriteCanvasInput {
  markdown: string;
  title?: string;
  // If set, appends markdown to this existing canvas instead of creating a new one.
  canvasId?: string;
  // Override channel (optional). When omitted, falls back to the job's output channel.
  channel?: { platform: string; id: string };
}

export interface WriteCanvasContext {
  jobOutputChannel?: { platform: string; id: string };
}

export interface WriteCanvasResult {
  ok: boolean;
  canvasId?: string;
  error?: string;
}

/**
 * Create a Slack canvas (or append to an existing one). When a channel is available, the canvas is
 * created channel-tabbed (works on free plans); a standalone canvas requires a paid plan.
 * Requires the bot to hold the canvases:write scope.
 */
export async function writeCanvas(
  input: WriteCanvasInput,
  ctx: WriteCanvasContext
): Promise<WriteCanvasResult> {
  if (!input.markdown) {
    return { ok: false, error: 'markdown is required' };
  }

  const channel = input.channel ?? ctx.jobOutputChannel;
  const platform = channel?.platform ?? 'slack';

  const result = await callTransportProxy('canvas', {
    platform,
    canvasId: input.canvasId,
    title: input.title,
    markdown: input.markdown,
    channelId: channel?.id,
  });

  return {
    ok: result.ok !== false,
    canvasId: result.canvasId as string | undefined,
    error: result.error,
  };
}
