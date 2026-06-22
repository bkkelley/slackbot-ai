import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { resolveProject } from '../channel-projects';
import { Logger } from '../../logger';
import { config } from '../../config';
import { CommandContext } from './types';

const SCHEDULER_DIR = path.join(__dirname, '../../../scheduler');
const VAULT_PATH = process.env.VAULT_PATH || `${process.env.HOME}/claude-workspaces/global`;
const GLOBAL_AGENTS_DIR = path.join(process.env.HOME || '', '.claude', 'agents');
const { listActionsForAgent } = require('../../../../shared/action-resolver.js');

type CreateStep = 'description' | 'agent' | 'action' | 'mode' | 'schedule' | 'schedule_hour' | 'schedule_day_hour' | 'schedule_dom_hour';

interface CreateSession {
  step: CreateStep;
  data: {
    description?: string;
    agentName?: string;
    agentAction?: string;
    mode?: 'sync' | 'async';
    agents?: string[];
    actions?: string[];
    schedulePreset?: string;
    scheduleDay?: string;
  };
}

export class JobsCommand {
  private logger = new Logger('JobsCommand');
  private createSessions = new Map<string, CreateSession>();

  constructor() {}

  private sessionKey(ctx: CommandContext): string {
    return `${ctx.channel}:${ctx.user}`;
  }

  async handle(ctx: CommandContext): Promise<boolean> {
    const { text, user, channel, thread_ts, ts, say } = ctx;
    const isDM = channel.startsWith('D');
    const key = this.sessionKey(ctx);

    if (this.createSessions.has(key)) {
      await this.handleCreateStep(ctx, key);
      return true;
    }

    if (/^jobs(\s+(list|status))?$/i.test(text.trim())) {
      await say({ text: this.formatJobsList(), thread_ts: thread_ts || ts });
      return true;
    }

    if (/^jobs\s+create$/i.test(text.trim())) {
      await this.startCreateSession(ctx, key);
      return true;
    }

    const cancelMatch = text.trim().match(/^jobs\s+cancel\s+([a-f0-9-]+)$/i);
    if (cancelMatch) {
      const result = this.cancelJob(cancelMatch[1]);
      await say({
        text: result.success
          ? `✅ Job cancelled: *${result.prompt}*\nID: \`${cancelMatch[1]}\``
          : `❌ ${result.error}`,
        thread_ts: thread_ts || ts,
      });
      return true;
    }

    const scheduleMatch = text.match(/^schedule\s+(.+)/is);
    if (scheduleMatch) {
      const scheduleText = scheduleMatch[1].trim();
      const workingDir = resolveProject(channel).dir
        || config.baseDirectory
        || `${process.env.HOME}/claude-workspaces`;
      await say({ text: '⏳ Analyzing your scheduling request...', thread_ts: thread_ts || ts });
      const job = await this.parseScheduleRequest(scheduleText, channel, workingDir, user);
      if (job) {
        await say({ text: this.formatJobConfirmation(job), thread_ts: thread_ts || ts });
      }
      return true;
    }

    return false;
  }

  private getAgentNames(): string[] {
    const names = new Set<string>();
    for (const agentsDir of [GLOBAL_AGENTS_DIR, path.join(VAULT_PATH, 'Agent')]) {
      if (!fs.existsSync(agentsDir)) continue;
      for (const file of fs.readdirSync(agentsDir)) {
        if (file.endsWith('.md')) names.add(file.slice(0, -3));
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  private getAgentActions(agentName: string): string[] {
    return listActionsForAgent(agentName).map((action: { name: string }) => action.name);
  }

  private async startCreateSession(ctx: CommandContext, key: string): Promise<void> {
    const { thread_ts, ts, say } = ctx;
    const agents = this.getAgentNames();
    if (agents.length === 0) {
      await say({ text: `❌ No agents found. Create one first with \`agents create\`.`, thread_ts: thread_ts || ts });
      return;
    }
    this.createSessions.set(key, { step: 'description', data: { agents } });
    await say({
      text: `📅 *New job setup*\n\nWhat's a short description for this job? _(type \`cancel\` at any point to stop)_`,
      thread_ts: thread_ts || ts,
    });
  }

  private async handleCreateStep(ctx: CommandContext, key: string): Promise<void> {
    const { thread_ts, ts, say } = ctx;
    const session = this.createSessions.get(key)!;
    const input = ctx.text.trim();

    if (input.toLowerCase() === 'cancel') {
      this.createSessions.delete(key);
      await say({ text: `_Cancelled._`, thread_ts: thread_ts || ts });
      return;
    }

    switch (session.step) {
      case 'description': {
        session.data.description = input;
        session.step = 'agent';
        const list = session.data.agents!.map((a, i) => `*${i + 1}* — ${a}`).join('\n');
        await say({ text: `Which agent?\n\n${list}`, thread_ts: thread_ts || ts });
        break;
      }

      case 'agent': {
        const agents = session.data.agents!;
        const idx = parseInt(input, 10) - 1;
        const name = agents[idx] || agents.find(a => a.toLowerCase() === input.toLowerCase());
        if (!name) {
          await say({ text: `❌ Pick a number from the list.`, thread_ts: thread_ts || ts });
          return;
        }
        session.data.agentName = name;
        const actions = this.getAgentActions(name);
        if (actions.length === 0) {
          await say({ text: `❌ No action templates found for *${name}*. Add one to \`~/.agents/actions/\` first.`, thread_ts: thread_ts || ts });
          this.createSessions.delete(key);
          return;
        }
        session.data.actions = actions;
        session.step = 'action';
        const list = actions.map((a, i) => `*${i + 1}* — ${a}`).join('\n');
        await say({ text: `Which action?\n\n${list}`, thread_ts: thread_ts || ts });
        break;
      }

      case 'action': {
        const actions = session.data.actions!;
        const idx = parseInt(input, 10) - 1;
        const action = actions[idx] || actions.find(a => a.toLowerCase() === input.toLowerCase());
        if (!action) {
          await say({ text: `❌ Pick a number from the list.`, thread_ts: thread_ts || ts });
          return;
        }
        session.data.agentAction = action;
        session.step = 'mode';
        await say({
          text: `How should this job run?\n\n*1* — Synchronously (single session, atomic updates)\n*2* — Asynchronously (parallel execution, real-time feedback)\n\n_(Pick sync for single-purpose tasks like documentation updates, async for complex multi-step workflows)_`,
          thread_ts: thread_ts || ts,
        });
        break;
      }

      case 'mode': {
        if (input === '1') {
          session.data.mode = 'sync';
          session.step = 'schedule';
          await say({
            text: `How often should it run?\n\n*1* — Every 15 min\n*2* — Every 30 min\n*3* — Hourly\n*4* — Daily (pick a time)\n*5* — Weekly (pick a day + time)\n*6* — Custom cron`,
            thread_ts: thread_ts || ts,
          });
        } else if (input === '2') {
          session.data.mode = 'async';
          session.step = 'schedule';
          await say({
            text: `How often should it run?\n\n*1* — Every 15 min\n*2* — Every 30 min\n*3* — Hourly\n*4* — Daily (pick a time)\n*5* — Weekly (pick a day + time)\n*6* — Custom cron`,
            thread_ts: thread_ts || ts,
          });
        } else {
          await say({ text: `❌ Pick a number 1 or 2.`, thread_ts: thread_ts || ts });
        }
        break;
      }

      case 'schedule': {
        const presets: Record<string, string> = { '1': '*/15 * * * *', '2': '*/30 * * * *', '3': '0 * * * *' };
        if (presets[input]) {
          session.data.schedulePreset = presets[input];
          await this.finishCreateJob(ctx, key);
        } else if (input === '4') {
          session.step = 'schedule_hour';
          await say({ text: `What hour should it run? _(0–23, UTC)_`, thread_ts: thread_ts || ts });
        } else if (input === '5') {
          session.step = 'schedule_day_hour';
          await say({ text: `Which day?\n\n*0* Sun · *1* Mon · *2* Tue · *3* Wed · *4* Thu · *5* Fri · *6* Sat`, thread_ts: thread_ts || ts });
        } else if (input === '6') {
          session.step = 'schedule_dom_hour';
          await say({ text: `Enter a cron expression _(e.g. \`0 8 * * *\`)_:`, thread_ts: thread_ts || ts });
        } else {
          await say({ text: `❌ Pick a number 1–6.`, thread_ts: thread_ts || ts });
        }
        break;
      }

      case 'schedule_hour': {
        const h = parseInt(input, 10);
        if (isNaN(h) || h < 0 || h > 23) {
          await say({ text: `❌ Enter a number 0–23.`, thread_ts: thread_ts || ts });
          return;
        }
        session.data.schedulePreset = `0 ${h} * * *`;
        await this.finishCreateJob(ctx, key);
        break;
      }

      case 'schedule_day_hour': {
        const parts = input.trim().split(/\s+/);
        const day = parseInt(parts[0], 10);
        const hour = parseInt(parts[1] ?? '8', 10);
        if (isNaN(day) || day < 0 || day > 6) {
          await say({ text: `❌ Enter day (0–6) and optionally hour (0–23), e.g. \`1 8\` for Monday at 8am.`, thread_ts: thread_ts || ts });
          return;
        }
        session.data.schedulePreset = `0 ${isNaN(hour) ? 8 : hour} * * ${day}`;
        await this.finishCreateJob(ctx, key);
        break;
      }

      case 'schedule_dom_hour': {
        if (!/^[\d*/,\-\s]+$/.test(input) || input.trim().split(/\s+/).length !== 5) {
          await say({ text: `❌ Enter a valid 5-field cron expression.`, thread_ts: thread_ts || ts });
          return;
        }
        session.data.schedulePreset = input.trim();
        await this.finishCreateJob(ctx, key);
        break;
      }
    }

    if (this.createSessions.has(key)) this.createSessions.set(key, session);
  }

  private async finishCreateJob(ctx: CommandContext, key: string): Promise<void> {
    const { thread_ts, ts, say } = ctx;
    const session = this.createSessions.get(key)!;
    this.createSessions.delete(key);

    const { description, agentName, agentAction, schedulePreset, mode } = session.data;
    const id = `${agentName!.toLowerCase()}-${agentAction!.toLowerCase().replace(/\s+/g, '-')}`;

    const jobs = this.readJobsFile();
    const existingIdx = jobs.findIndex(j => j.id === id);

    let job: any = { id, description, cron: schedulePreset, enabled: true, lastRun: null };

    job.agent = agentName;
    job.action = agentAction;
    job.mode = mode ?? 'async';
    job.toolset = 'default';

    if (existingIdx !== -1) {
      jobs[existingIdx] = { ...jobs[existingIdx], ...job };
    } else {
      jobs.push(job);
    }
    this.writeJobsFile(jobs);

    const modeStr = mode === 'sync' ? '🔄 synchronous' : '⚡ asynchronous';
    await say({
      text: [
        `✅ *Job created!*`,
        `  Description: ${description}`,
        `  Agent: *${agentName}* / _${agentAction}_`,
        `  Mode: ${modeStr}`,
        `  Schedule: \`${schedulePreset}\``,
        `  ID: \`${id}\``,
      ].join('\n'),
      thread_ts: thread_ts || ts,
    });
  }

  private formatJobConfirmation(job: any): string {
    if (job.scheduleType === 'once') {
      const runAt = new Date(job.runAt);
      const timeStr = runAt.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' });
      const minsAway = Math.round((runAt.getTime() - Date.now()) / 60000);
      const whenStr = minsAway < 60 ? `in ~${minsAway} minute${minsAway === 1 ? '' : 's'} (${timeStr})` : timeStr;
      return `✅ *Reminder set!*\n*Reminder:* ${job.prompt}\n*When:* ${whenStr}\n*Job ID:* \`${job.id}\`\n\nI'll ping you here when it's time.`;
    }
    const humanCron = this.describeCron(job.cron);
    return `✅ *Scheduled job created!*\n*Task:* ${job.prompt}\n*Schedule:* ${humanCron} (\`${job.cron}\`)\n*Working dir:* \`${job.workingDir}\`\n*Job ID:* \`${job.id}\`\n\nI'll post results here when it runs.`;
  }

  private async parseScheduleRequest(text: string, channel: string, workingDir: string, userId: string): Promise<any | null> {
    return new Promise((resolve) => {
      const child = spawn('node', [path.join(SCHEDULER_DIR, 'parser.js'), text, channel, workingDir, userId]);
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.on('close', () => {
        try {
          const job = JSON.parse(stdout.trim());
          resolve(job?.id ? job : null);
        } catch { resolve(null); }
      });
      child.on('error', (err: Error) => { this.logger.error('Scheduler parser error', err); resolve(null); });
      setTimeout(() => { child.kill(); resolve(null); }, 90_000);
    });
  }

  private describeCron(cron: string): string {
    const map: Record<string, string> = {
      '0 9 * * *':    'daily at 9 AM',
      '0 8 * * 1':    'every Monday at 8 AM',
      '0 10 * * 1-5': 'weekdays at 10 AM',
      '0 * * * *':    'every hour',
      '0 18 * * 0':   'every Sunday at 6 PM',
    };
    return map[cron] ?? cron;
  }

  private readJobsFile(): any[] {
    try {
      return JSON.parse(fs.readFileSync(path.join(SCHEDULER_DIR, 'jobs.json'), 'utf8'));
    } catch { return []; }
  }

  private writeJobsFile(jobs: any[]): void {
    fs.writeFileSync(path.join(SCHEDULER_DIR, 'jobs.json'), JSON.stringify(jobs, null, 2), 'utf8');
  }

  private formatJobsList(): string {
    const jobs = this.readJobsFile();
    if (jobs.length === 0) return '📭 No scheduled jobs or reminders found.';

    const active = jobs.filter(j => j.enabled);
    const inactive = jobs.filter(j => !j.enabled);

    const formatJob = (j: any): string => {
      const typeEmoji = j.scheduleType === 'once' ? '🔔' : '🔁';
      const preview = j.prompt ? (j.prompt.length > 60 ? j.prompt.slice(0, 57) + '...' : j.prompt) : j.command?.slice(0, 60) + '...';
      const scheduleStr = j.scheduleType === 'once'
        ? `Run at: ${new Date(j.runAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' })}`
        : `Schedule: ${this.describeCron(j.cron)} (\`${j.cron}\`)`;
      const lastRun = j.lastRun
        ? `Last run: ${new Date(j.lastRun).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' })}`
        : 'Never run';
      const lines = [`${typeEmoji} *${preview}*`, `  ID: \`${j.id}\`  •  ${scheduleStr}  •  ${lastRun}`];
      if (j.workingDir) lines.push(`  Dir: \`${j.workingDir}\``);
      return lines.join('\n');
    };

    const parts: string[] = ['📅 *Scheduled Jobs & Reminders*\n'];
    if (active.length > 0) { parts.push(`*Active (${active.length}):*`); parts.push(...active.map(formatJob)); }
    if (inactive.length > 0) { parts.push(`\n*Inactive / Completed (${inactive.length}):*`); parts.push(...inactive.map(formatJob)); }
    parts.push('\nUse `jobs cancel <id>` to cancel a job.');
    return parts.join('\n');
  }

  private cancelJob(id: string): { success: boolean; prompt?: string; error?: string } {
    const jobs = this.readJobsFile();
    const idx = jobs.findIndex(j => j.id === id);
    if (idx === -1) return { success: false, error: `No job found with ID \`${id}\`.` };
    if (!jobs[idx].enabled) return { success: false, error: `Job \`${id}\` is already inactive.` };
    jobs[idx].enabled = false;
    this.writeJobsFile(jobs);
    return { success: true, prompt: jobs[idx].prompt };
  }
}
