import { callTransportProxy } from './transport-proxy.js';

export interface ScheduleContext {
  jobOutputChannel?: { platform: string; id: string };
  jobThreadId?: string;
}

// --- ScheduleMessage ---

export interface ScheduleMessageInput {
  text: string;
  // Unix timestamp in SECONDS for when the message should post (up to 120 days out).
  postAt: number;
  channel?: { platform: string; id: string };
  threadId?: string;
}

export interface ScheduleMessageResult {
  ok: boolean;
  scheduledMessageId?: string;
  postAt?: number;
  error?: string;
}

/**
 * Schedule a message to post at a future time via Slack's chat.scheduleMessage (durable; the
 * preferred path for time-based delivery). Requires chat:write.
 */
export async function scheduleMessage(
  input: ScheduleMessageInput,
  ctx: ScheduleContext
): Promise<ScheduleMessageResult> {
  if (!input.text) return { ok: false, error: 'text is required' };
  if (!input.postAt) return { ok: false, error: 'postAt (unix seconds) is required' };

  const channel = input.channel ?? ctx.jobOutputChannel;
  if (!channel) return { ok: false, error: 'No channel configured for job and none provided' };

  const result = await callTransportProxy('schedule-message', {
    platform: channel.platform,
    channelId: channel.id,
    threadId: input.threadId ?? ctx.jobThreadId,
    text: input.text,
    postAt: input.postAt,
  });

  return {
    ok: result.ok !== false,
    scheduledMessageId: result.scheduledMessageId as string | undefined,
    postAt: result.postAt as number | undefined,
    error: result.error,
  };
}

// --- ListScheduledMessages ---

export interface ListScheduledInput {
  channel?: { platform: string; id: string };
}

export interface ListScheduledResult {
  ok: boolean;
  messages?: Array<{ id: string; channelId: string; postAt: number; text?: string }>;
  error?: string;
}

export async function listScheduledMessages(
  input: ListScheduledInput,
  ctx: ScheduleContext
): Promise<ListScheduledResult> {
  const channel = input.channel ?? ctx.jobOutputChannel;
  const result = await callTransportProxy('list-scheduled', {
    platform: channel?.platform ?? 'slack',
    channelId: channel?.id,
  });
  return {
    ok: result.ok !== false,
    messages: result.messages as ListScheduledResult['messages'],
    error: result.error,
  };
}

// --- CancelScheduledMessage ---

export interface CancelScheduledInput {
  scheduledMessageId: string;
  channel?: { platform: string; id: string };
}

export interface CancelScheduledResult {
  ok: boolean;
  error?: string;
}

export async function cancelScheduledMessage(
  input: CancelScheduledInput,
  ctx: ScheduleContext
): Promise<CancelScheduledResult> {
  if (!input.scheduledMessageId) return { ok: false, error: 'scheduledMessageId is required' };

  const channel = input.channel ?? ctx.jobOutputChannel;
  if (!channel) return { ok: false, error: 'No channel configured for job and none provided' };

  const result = await callTransportProxy('cancel-scheduled', {
    platform: channel.platform,
    channelId: channel.id,
    scheduledMessageId: input.scheduledMessageId,
  });
  return { ok: result.ok !== false, error: result.error };
}
