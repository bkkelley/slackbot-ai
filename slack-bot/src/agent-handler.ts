import { Logger } from './logger.js';
import { RuntimeApiClient } from './runtime-api-client.js';

export const VAULT_PATH = process.env.VAULT_PATH || `${process.env.HOME}/claude-workspaces/global`;

// Agent channel map: channel ID → { agent name, working directory }
export const AGENT_CHANNELS: Record<string, { agent: string; dir: string }> = {};
if (process.env.SAGE_CHANNEL) {
  AGENT_CHANNELS[process.env.SAGE_CHANNEL] = {
    agent: 'Sage',
    dir: process.env.SAGE_DIR ?? `${process.env.HOME}/claude-workspaces/sage`,
  };
}

export function isAgentChannel(channel: string): boolean {
  return channel in AGENT_CHANNELS;
}

export function agentForChannel(channel: string): string | null {
  return AGENT_CHANNELS[channel]?.agent || null;
}

export function dirForChannel(channel: string): string {
  return AGENT_CHANNELS[channel]?.dir ?? VAULT_PATH;
}

export function isSageCheckinTrigger(text: string): boolean {
  return /^\/checkin\b|^sage,?\s*(check[- ]?in|let'?s (do|talk)|i want to (talk|check in))/i.test(text.trim())
    || /^(check in with sage|do a check.?in|start a check.?in)/i.test(text.trim());
}

export interface AgentMessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
}

export class AgentHandler {
  private logger = new Logger('AgentHandler');
  private runtimeApi = new RuntimeApiClient();
  // Map from Slack threadTs → runtime sessionId (for ongoing check-ins)
  // This is in-memory only; survives for the life of the bot process.
  // The runtime's jobs.db is the source of truth; this just avoids re-generating session IDs.
  private activeSessions: Map<string, string> = new Map(); // threadTs → sessionId

  async handle(event: AgentMessageEvent, say: (opts: any) => Promise<any>): Promise<boolean> {
    const { channel, thread_ts, ts, text } = event;

    if (!isAgentChannel(channel)) return false;

    const agentName = agentForChannel(channel)!;
    const replyText = (text || '').replace(/<[^>]+>/g, '').trim();
    const slackChannel = channel;

    // 1. Check-in trigger on a top-level message
    if (!thread_ts && text && isSageCheckinTrigger(text)) {
      await say({ text: `_Starting a check-in with ${agentName}…_`, thread_ts: ts });
      const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const result = await this.runtimeApi.submitJob({
          agent: agentName,
          action: 'Socratic Check-in',
          mode: 'async',
          sessionId,
          outputChannel: { platform: 'slack', id: slackChannel },
          threadId: ts,
          trigger: 'manual',
        });
        this.activeSessions.set(ts, sessionId);
        this.logger.info('Check-in started', { agentName, sessionId, jobId: result.jobId });
      } catch (err: any) {
        this.logger.error('Check-in submission failed', { error: err.message });
        await say({ text: `⚠️ ${agentName} check-in failed to start. Check runtime logs.`, thread_ts: ts });
      }
      return true;
    }

    // 2. Thread reply in an active check-in session
    if (thread_ts) {
      const sessionId = this.activeSessions.get(thread_ts);
      if (sessionId) {
        try {
          await this.runtimeApi.submitJob({
            agent: agentName,
            action: 'Socratic Check-in',
            mode: 'async',
            sessionId,
            replyText,
            outputChannel: { platform: 'slack', id: slackChannel },
            threadId: thread_ts,
            trigger: 'manual',
          });
        } catch (err: any) {
          this.logger.error('Check-in reply failed', { error: err.message });
          await say({ text: `⚠️ ${agentName} had trouble responding. Try again.`, thread_ts });
        }
        return true;
      }
    }

    // 3. Thread reply to a dispatcher-originated message (nudge, downshift, etc.)
    if (thread_ts) {
      // For now, any thread reply in an agent channel that isn't a check-in session
      // goes to Thread Reply action
      try {
        await this.runtimeApi.submitJob({
          agent: agentName,
          action: 'Thread Reply',
          mode: 'async',
          replyText,
          outputChannel: { platform: 'slack', id: slackChannel },
          threadId: thread_ts,
          trigger: 'manual',
        });
      } catch (err: any) {
        this.logger.error('Thread reply failed', { error: err.message });
        await say({ text: `⚠️ ${agentName} had trouble responding. Try again.`, thread_ts });
      }
      return true;
    }

    // 4. Top-level message — fall through to Claude Code
    return false;
  }
}
