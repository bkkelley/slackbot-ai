import { Logger } from '../../logger.js';
import { AgentJob } from '../../types.js';
import { NotificationSeverity, resolveNotificationPreference, shouldSendNotification } from '../../notifications.js';

const logger = new Logger('post-message');

const BOT_HTTP_PORT = process.env.BOT_HTTP_PORT || '3458';
const BOT_RUNTIME_SHARED_SECRET = process.env.BOT_RUNTIME_SHARED_SECRET || '';

export interface PostMessageInput {
  text: string;
  channel?: { platform: string; id: string };
  threadId?: string;
  notificationKind?: 'normal' | 'failure';
  notificationSeverity?: NotificationSeverity;
}

export interface PostMessageContext {
  jobOutputChannel?: { platform: string; id: string };
  jobThreadId?: string;
  job?: Pick<AgentJob, 'agent' | 'workflow' | 'toolset' | 'trigger'>;
}

export interface PostMessageResult {
  ok: boolean;
  messageId?: string;
  suppressed?: boolean;
  error?: string;
}

export async function postMessage(
  input: PostMessageInput,
  ctx: PostMessageContext
): Promise<PostMessageResult> {
  const preference = resolveNotificationPreference(ctx.job);
  const kind = input.notificationKind ?? 'normal';
  if (!shouldSendNotification(preference, kind, input.notificationSeverity)) {
    logger.info('Notification suppressed by preference', {
      mode: preference.mode,
      kind,
      severity: input.notificationSeverity,
      agent: ctx.job?.agent,
      workflow: ctx.job?.workflow,
      trigger: ctx.job?.trigger,
      toolset: ctx.job?.toolset,
    });
    return { ok: true, suppressed: true };
  }

  const channel = input.channel ?? preference.channel ?? ctx.jobOutputChannel;
  if (!channel) {
    return { ok: false, error: 'No channel configured for job and none provided' };
  }

  const threadId = input.threadId ?? ctx.jobThreadId;

  const payload = {
    platform: channel.platform,
    channelId: channel.id,
    text: input.text,
    threadId,
  };

  try {
    const resp = await fetch(
      `http://127.0.0.1:${BOT_HTTP_PORT}/api/transport-proxy/send`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Auth': BOT_RUNTIME_SHARED_SECRET,
        },
        body: JSON.stringify(payload),
      }
    );

    if (!resp.ok) {
      const body = await resp.text();
      logger.warn('Bot transport-proxy returned error', {
        status: resp.status,
        body: body.slice(0, 200),
      });
      return { ok: false, error: `Bot returned ${resp.status}: ${body.slice(0, 200)}` };
    }

    const data = (await resp.json()) as { ok?: boolean; ts?: string; messageId?: string; error?: string };
    return {
      ok: data.ok !== false,
      messageId: data.ts ?? data.messageId,
      error: data.error,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Bot unreachable', { error: msg });
    return { ok: false, error: `bot unreachable: ${msg}` };
  }
}
