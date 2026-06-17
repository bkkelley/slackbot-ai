import { Logger } from '../../logger';
import { CommandContext } from './types';
import { config } from '../../config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vault = require('../../../../shared/vault');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const scaffold = require('../../../../shared/scaffold');

type Step = 'name' | 'instructions' | 'model';

interface CreationSession {
  step: Step;
  data: {
    name?: string;
    instructions?: string;
    model?: string;
  };
}

export class AgentsCommand {
  private logger = new Logger('AgentsCommand');
  private sessions = new Map<string, CreationSession>();

  private sessionKey(ctx: CommandContext): string {
    return `${ctx.channel}:${ctx.user}`;
  }

  async handle(ctx: CommandContext): Promise<boolean> {
    const { text, channel, thread_ts, ts, say } = ctx;
    const key = this.sessionKey(ctx);

    // If there's an active creation session for this user, intercept the message
    if (this.sessions.has(key)) {
      await this.handleCreationStep(ctx, key);
      return true;
    }

    if (!/^\$agents(\s+.*)?$/i.test(text.trim())) return false;

    const sub = text.trim().replace(/^\$agents\s*/i, '').trim();

    if (!sub || sub === 'list') {
      await say({ text: this.formatAgentsList(), thread_ts: thread_ts || ts });
      return true;
    }

    if (sub === 'create') {
      this.sessions.set(key, { step: 'name', data: {} });
      await say({
        text: `🤖 *New agent setup*\n\nWhat should we call this agent? _(type \`cancel\` at any point to stop)_`,
        thread_ts: thread_ts || ts,
      });
      return true;
    }

    const deleteMatch = sub.match(/^delete\s+(\S+)$/i);
    if (deleteMatch) {
      await this.handleDelete(deleteMatch[1], ctx);
      return true;
    }

    const runMatch = sub.match(/^run\s+(\S+)\s+(.+)$/i);
    if (runMatch) {
      const agentName = runMatch[1];
      const rest = runMatch[2].trim();
      const filesMatch = rest.match(/^(.*?)\s+--files\s+(.+)$/i);
      if (filesMatch) {
        await this.handleRun(agentName, filesMatch[1].trim(), ctx, filesMatch[2].trim());
      } else {
        await this.handleRun(agentName, rest, ctx);
      }
      return true;
    }

    await say({
      text: `*Agent commands:*\n• \`$agents list\` — list all agents\n• \`$agents create\` — create a new agent\n• \`$agents delete <name>\` — delete an agent\n• \`$agents run <name> <action> [--files <path>]\` — dispatch an agent action\n\nOr manage at http://localhost:3456/agents/`,
      thread_ts: thread_ts || ts,
    });
    return true;
  }

  private async handleCreationStep(ctx: CommandContext, key: string): Promise<void> {
    const { text, channel, thread_ts, ts, say } = ctx;
    const session = this.sessions.get(key)!;
    const input = text.trim();

    if (input.toLowerCase() === 'cancel') {
      this.sessions.delete(key);
      await say({ text: `_Cancelled._`, thread_ts: thread_ts || ts });
      return;
    }

    switch (session.step) {
      case 'name': {
        if (!input || input.includes(' ')) {
          await say({ text: `❌ Name must be a single word (e.g. \`WeatherBot\`). Try again:`, thread_ts: thread_ts || ts });
          return;
        }
        session.data.name = input;
        session.step = 'instructions';
        await say({ text: `What does *${input}* do? Describe its purpose and instructions:`, thread_ts: thread_ts || ts });
        break;
      }

      case 'instructions': {
        session.data.instructions = input;
        session.step = 'model';
        await say({
          text: `Which model?\n\n*1* — Haiku (fast, cheap) _(default)_\n*2* — Sonnet (more capable)`,
          thread_ts: thread_ts || ts,
        });
        break;
      }

      case 'model': {
        if (input === '2' || /sonnet/i.test(input)) {
          session.data.model = 'claude-sonnet-4-6';
        } else {
          session.data.model = 'claude-haiku-4-5-20251001';
        }
        await this.finishCreation(ctx, key);
        break;
      }
    }

    // Keep session alive if not finished
    if (this.sessions.has(key)) this.sessions.set(key, session);
  }

  private async finishCreation(ctx: CommandContext, key: string): Promise<void> {
    const { channel, thread_ts, ts, say } = ctx;
    const session = this.sessions.get(key)!;
    this.sessions.delete(key);

    const { name, instructions, model } = session.data;
    const modelLabel = model === 'claude-sonnet-4-6' ? 'Sonnet' : 'Haiku';

    await say({ text: `⏳ Creating *${name}*...`, thread_ts: thread_ts || ts });

    try {
      scaffold.createAgent({ name, instructions, model, triggerType: 'none' });
      await say({
        text: [
          `✅ *${name}* created!`,
          `  Model: \`${modelLabel}\``,
          `  Agent: \`~/.claude/agents/${name}.md\``,
          `  Workspace: \`claude-workspaces/${name!.toLowerCase()}/\``,
          `\nWant to schedule it? Run \`$jobs create\` to set up a recurring job.`,
        ].join('\n'),
        thread_ts: thread_ts || ts,
      });
    } catch (err: any) {
      this.logger.error('Failed to create agent', err);
      await say({ text: `❌ Failed to create agent: ${err.message}`, thread_ts: thread_ts || ts });
    }
  }

  private async handleDelete(name: string, ctx: CommandContext): Promise<void> {
    const { channel, thread_ts, ts, say } = ctx;
    try {
      scaffold.deleteAgent(name, { removeWorkspace: false });
      await say({
        text: `✅ *${name}* deleted. Workspace directory was left intact.\n\nManage at http://localhost:3456/agents/`,
        thread_ts: thread_ts || ts,
      });
    } catch (err: any) {
      await say({ text: `❌ Failed to delete agent: ${err.message}`, thread_ts: thread_ts || ts });
    }
  }

  private async handleRun(agentName: string, action: string, ctx: CommandContext, files?: string): Promise<void> {
    const { thread_ts, ts, say } = ctx;
    const threadTs = thread_ts || ts;

    const filesNote = files ? ` on \`${files.split(',').map(f => f.split('/').pop()).join(', ')}\`` : '';
    await say({ text: `⏳ Dispatching *${agentName}* / _${action}_${filesNote}...`, thread_ts: threadTs });

    try {
      await this.runDispatcher(agentName, action, files);
      await say({ text: `✅ *${agentName}* / _${action}_ completed.`, thread_ts: threadTs });
    } catch (err: any) {
      this.logger.error('Dispatcher run failed', err);
      await say({ text: `❌ Dispatch failed: ${err.message}`, thread_ts: threadTs });
    }
  }

  private async runDispatcher(agentName: string, action: string, files?: string): Promise<void> {
    const runtimeUrl = `http://127.0.0.1:${config.runtimeHttpPort}/api/agents/${encodeURIComponent(agentName)}/run`;
    const body: Record<string, unknown> = { action, mode: 'async', toolset: 'default' };
    if (files) body.files = files.split(',').map(f => f.trim());

    const resp = await fetch(runtimeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bot-Auth': config.botRuntimeSharedSecret },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Runtime API error ${resp.status}: ${text.slice(0, 200)}`);
    }
  }

  private formatAgentsList(): string {
    try {
      const agents: any[] = vault.listAgents();
      if (agents.length === 0) return '📭 No agents found in vault.';

      const active = agents.filter((a: any) => a.status === 'Active');
      const inactive = agents.filter((a: any) => a.status !== 'Active');

      const fmt = (a: any): string => [
        `${a.status === 'Active' ? '🟢' : '⚫'} *${a.name}*`,
        `  Model: \`${a.model}\`  •  ${a.cadence}`,
        a.lastSession ? `  Last session: ${a.lastSession}` : '',
      ].filter(Boolean).join('\n');

      const parts = ['🤖 *Agents*\n'];
      if (active.length > 0) { parts.push(`*Active (${active.length}):*`); parts.push(...active.map(fmt)); }
      if (inactive.length > 0) { parts.push(`\n*Inactive (${inactive.length}):*`); parts.push(...inactive.map(fmt)); }
      parts.push('\nManage at http://localhost:3456/agents/');
      return parts.join('\n');
    } catch (err: any) {
      return `❌ Failed to load agents: ${err.message}`;
    }
  }
}
