import { callTransportProxy } from './transport-proxy.js';

export interface AddReminderInput {
  // Slack user ID to remind (e.g. "U12345"). With a bot token this can target another user.
  userId: string;
  text: string;
  // Unix timestamp (seconds), seconds-from-now, or natural language ("in 30 minutes",
  // "tomorrow at 9am").
  time: string | number;
  platform?: string;
}

export interface AddReminderResult {
  ok: boolean;
  reminderId?: string;
  error?: string;
}

/**
 * Create a native Slack reminder via reminders.add. Requires reminders:write.
 * NOTE: the reminders API is degraded and on a retirement path — prefer scheduleMessage for
 * durable time-based delivery; use this only when the native reminder UX is specifically wanted.
 */
export async function addReminder(input: AddReminderInput): Promise<AddReminderResult> {
  if (!input.userId) return { ok: false, error: 'userId is required' };
  if (!input.text) return { ok: false, error: 'text is required' };
  if (input.time === undefined || input.time === null || input.time === '') {
    return { ok: false, error: 'time is required' };
  }

  const result = await callTransportProxy('reminder', {
    platform: input.platform ?? 'slack',
    userId: input.userId,
    text: input.text,
    time: input.time,
  });

  return {
    ok: result.ok !== false,
    reminderId: result.reminderId as string | undefined,
    error: result.error,
  };
}
