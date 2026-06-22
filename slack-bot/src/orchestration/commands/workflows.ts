import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../logger';
import { config } from '../../config';
import { CommandContext } from './types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertSafeSegment } = require('../../../../shared/path-guard.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { listActionsForAgent } = require('../../../../shared/action-resolver.js');

const VAULT_PATH = process.env.VAULT_PATH || `${process.env.HOME}/claude-workspaces/global`;
const WORKFLOWS_DIR = path.join(VAULT_PATH, '_workflows');
const GLOBAL_AGENTS_DIR = path.join(process.env.HOME || '', '.claude', 'agents');

type CreateStep = 'name' | 'description' | 'step_agent' | 'step_action';

interface WorkflowStepDraft {
  agent: string;
  action: string;
}

interface CreateSession {
  step: CreateStep;
  data: {
    name?: string;
    description?: string;
    steps: WorkflowStepDraft[];
    agents?: string[];
    actions?: string[];
    pendingAgent?: string;
  };
}

/**
 * workflows — list / run / delete / create global workflows from Slack.
 * Workflows are stored as YAML+markdown at VAULT_PATH/_workflows/<name>.md (global scope).
 * Running posts results back to the current channel/thread via the runtime.
 */
export class WorkflowsCommand {
  private logger = new Logger('WorkflowsCommand');
  private sessions = new Map<string, CreateSession>();

  private sessionKey(ctx: CommandContext): string {
    return `${ctx.channel}:${ctx.user}`;
  }

  async handle(ctx: CommandContext): Promise<boolean> {
    const { text, thread_ts, ts, say } = ctx;
    const key = this.sessionKey(ctx);

    // Intercept an in-progress creation session
    if (this.sessions.has(key)) {
      await this.handleCreateStep(ctx, key);
      return true;
    }

    const trimmed = text.trim();
    if (!/^workflows(\s+.*)?$/i.test(trimmed)) return false;

    const sub = trimmed.replace(/^workflows\s*/i, '').trim();

    if (!sub || /^list$/i.test(sub)) {
      await say({ text: this.formatWorkflowsList(), thread_ts: thread_ts || ts });
      return true;
    }

    if (/^create$/i.test(sub)) {
      await this.startCreateSession(ctx, key);
      return true;
    }

    const runMatch = sub.match(/^run\s+(.+?)(?:\s+(sync|async))?$/i);
    if (runMatch) {
      await this.runWorkflow(ctx, runMatch[1].trim(), (runMatch[2]?.toLowerCase() as 'sync' | 'async') || 'async');
      return true;
    }

    const deleteMatch = sub.match(/^delete\s+(.+)$/i);
    if (deleteMatch) {
      await this.deleteWorkflow(ctx, deleteMatch[1].trim());
      return true;
    }

    await say({
      text: [
        '*workflows commands:*',
        '`workflows list` — list workflows',
        '`workflows run <name> [sync|async]` — run a workflow (default async)',
        '`workflows create` — author a workflow step-by-step',
        '`workflows delete <name>` — delete a global workflow',
      ].join('\n'),
      thread_ts: thread_ts || ts,
    });
    return true;
  }

  // --- list ---

  private listWorkflowDir(dir: string, scope: string | null): Array<{ name: string; steps: number; scope: string | null }> {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const name = f.slice(0, -3);
        let steps = 0;
        try {
          const content = fs.readFileSync(path.join(dir, f), 'utf8');
          const fm = content.match(/^---\n([\s\S]*?)\n---/);
          if (fm) steps = (fm[1].match(/^\s*-\s+type:/gm) || []).length;
        } catch { /* ignore unreadable file */ }
        return { name, steps, scope };
      });
  }

  private formatWorkflowsList(): string {
    const groups: Array<{ label: string; items: Array<{ name: string; steps: number }> }> = [];
    groups.push({ label: 'Global', items: this.listWorkflowDir(WORKFLOWS_DIR, null) });

    if (config.baseDirectory && fs.existsSync(config.baseDirectory)) {
      for (const d of fs.readdirSync(config.baseDirectory, { withFileTypes: true })) {
        if ((!d.isDirectory() && !d.isSymbolicLink()) || d.name.startsWith('.')) continue;
        const items = this.listWorkflowDir(path.join(config.baseDirectory, d.name, '.agents', 'workflows'), d.name);
        if (items.length > 0) groups.push({ label: d.name, items });
      }
    }

    const total = groups.reduce((n, g) => n + g.items.length, 0);
    if (total === 0) return '📭 No workflows found. Create one with `workflows create`.';

    const parts: string[] = ['🔁 *Workflows*'];
    for (const g of groups) {
      if (g.items.length === 0) continue;
      parts.push(`\n*${g.label}:*`);
      parts.push(...g.items.map((w) => `• \`${w.name}\` — ${w.steps} step${w.steps === 1 ? '' : 's'}`));
    }
    parts.push('\nRun one with `workflows run <name>`.');
    return parts.join('\n');
  }

  // --- run ---

  private async runWorkflow(ctx: CommandContext, name: string, mode: 'sync' | 'async'): Promise<void> {
    const { channel, thread_ts, ts, say } = ctx;
    let safeName: string;
    try {
      safeName = assertSafeSegment(name, 'workflow name');
    } catch {
      await say({ text: `❌ Invalid workflow name: \`${name}\``, thread_ts: thread_ts || ts });
      return;
    }

    await say({ text: `▶️ Running workflow *${safeName}* (${mode})…`, thread_ts: thread_ts || ts });

    try {
      const resp = await fetch(
        `http://127.0.0.1:${config.runtimeHttpPort}/api/workflows/${encodeURIComponent(safeName)}/run`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Bot-Auth': config.botRuntimeSharedSecret },
          body: JSON.stringify({
            mode,
            outputChannel: { platform: 'slack', id: channel },
            threadId: thread_ts || ts,
          }),
        }
      );

      if (!resp.ok) {
        const body = await resp.text();
        await say({ text: `❌ Workflow failed to start (${resp.status}): \`${body.slice(0, 300)}\``, thread_ts: thread_ts || ts });
        return;
      }

      const data = (await resp.json()) as { jobId?: string; status?: string };
      const msg = mode === 'sync'
        ? `✅ Workflow *${safeName}* finished. Job \`${data.jobId}\`.`
        : `✅ Workflow *${safeName}* started (job \`${data.jobId}\`). I'll post results here as steps complete.`;
      await say({ text: msg, thread_ts: thread_ts || ts });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.logger.error('Workflow run failed', { name: safeName, error: m });
      await say({ text: `❌ Could not reach the runtime: \`${m}\``, thread_ts: thread_ts || ts });
    }
  }

  // --- delete ---

  private async deleteWorkflow(ctx: CommandContext, name: string): Promise<void> {
    const { thread_ts, ts, say } = ctx;
    let safeName: string;
    try {
      safeName = assertSafeSegment(name, 'workflow name');
    } catch {
      await say({ text: `❌ Invalid workflow name: \`${name}\``, thread_ts: thread_ts || ts });
      return;
    }
    const file = path.join(WORKFLOWS_DIR, `${safeName}.md`);
    if (!fs.existsSync(file)) {
      await say({ text: `❌ No global workflow named \`${safeName}\`.`, thread_ts: thread_ts || ts });
      return;
    }
    try {
      fs.unlinkSync(file);
      await say({ text: `🗑️ Deleted workflow \`${safeName}\`.`, thread_ts: thread_ts || ts });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      await say({ text: `❌ Delete failed: \`${m}\``, thread_ts: thread_ts || ts });
    }
  }

  // --- create (conversational) ---

  private getAgentNames(): string[] {
    const names = new Set<string>();
    for (const dir of [GLOBAL_AGENTS_DIR, path.join(VAULT_PATH, 'Agent')]) {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.md')) names.add(file.slice(0, -3));
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  private getAgentActions(agentName: string): string[] {
    return listActionsForAgent(agentName).map((a: { name: string }) => a.name);
  }

  private async startCreateSession(ctx: CommandContext, key: string): Promise<void> {
    const { thread_ts, ts, say } = ctx;
    this.sessions.set(key, { step: 'name', data: { steps: [] } });
    await say({
      text: `🔁 *New workflow*\n\nWhat should we name it? _(type \`cancel\` any time to stop)_`,
      thread_ts: thread_ts || ts,
    });
  }

  private async handleCreateStep(ctx: CommandContext, key: string): Promise<void> {
    const { thread_ts, ts, say } = ctx;
    const session = this.sessions.get(key)!;
    const input = ctx.text.trim();

    if (input.toLowerCase() === 'cancel') {
      this.sessions.delete(key);
      await say({ text: `_Cancelled._`, thread_ts: thread_ts || ts });
      return;
    }

    switch (session.step) {
      case 'name': {
        try {
          assertSafeSegment(input, 'workflow name');
        } catch {
          await say({ text: `❌ Use a simple name (letters, numbers, spaces, dashes).`, thread_ts: thread_ts || ts });
          return;
        }
        if (fs.existsSync(path.join(WORKFLOWS_DIR, `${input}.md`))) {
          await say({ text: `❌ A workflow named \`${input}\` already exists. Pick another name or \`cancel\`.`, thread_ts: thread_ts || ts });
          return;
        }
        session.data.name = input;
        session.step = 'description';
        await say({ text: `Short description of what *${input}* does?`, thread_ts: thread_ts || ts });
        break;
      }

      case 'description': {
        session.data.description = input;
        const agents = this.getAgentNames();
        if (agents.length === 0) {
          this.sessions.delete(key);
          await say({ text: `❌ No agents found. Create one with \`agents create\` first.`, thread_ts: thread_ts || ts });
          return;
        }
        session.data.agents = agents;
        session.step = 'step_agent';
        await say({ text: `Add the first step — which agent?\n\n${this.numberedList(agents)}`, thread_ts: thread_ts || ts });
        break;
      }

      case 'step_agent': {
        if (/^done$/i.test(input) && session.data.steps.length > 0) {
          await this.finishCreate(ctx, key);
          return;
        }
        const agents = session.data.agents!;
        const idx = parseInt(input, 10) - 1;
        const name = agents[idx] || agents.find((a) => a.toLowerCase() === input.toLowerCase());
        if (!name) {
          await say({ text: `❌ Pick an agent number from the list${session.data.steps.length > 0 ? ', or type `done`' : ''}.`, thread_ts: thread_ts || ts });
          return;
        }
        const actions = this.getAgentActions(name);
        if (actions.length === 0) {
          await say({ text: `❌ No action templates for *${name}*. Pick another agent.`, thread_ts: thread_ts || ts });
          return;
        }
        session.data.pendingAgent = name;
        session.data.actions = actions;
        session.step = 'step_action';
        await say({ text: `Which action for *${name}*?\n\n${this.numberedList(actions)}`, thread_ts: thread_ts || ts });
        break;
      }

      case 'step_action': {
        const actions = session.data.actions!;
        const idx = parseInt(input, 10) - 1;
        const action = actions[idx] || actions.find((a) => a.toLowerCase() === input.toLowerCase());
        if (!action) {
          await say({ text: `❌ Pick an action number from the list.`, thread_ts: thread_ts || ts });
          return;
        }
        session.data.steps.push({ agent: session.data.pendingAgent!, action });
        session.step = 'step_agent';
        await say({
          text: `✅ Step ${session.data.steps.length}: *${session.data.pendingAgent}* / _${action}_.\n\nAdd another step (pick an agent number), or type \`done\` to save.\n\n${this.numberedList(session.data.agents!)}`,
          thread_ts: thread_ts || ts,
        });
        break;
      }
    }

    if (this.sessions.has(key)) this.sessions.set(key, session);
  }

  private numberedList(items: string[]): string {
    return items.map((a, i) => `*${i + 1}* — ${a}`).join('\n');
  }

  private async finishCreate(ctx: CommandContext, key: string): Promise<void> {
    const { channel, thread_ts, ts, say } = ctx;
    const session = this.sessions.get(key)!;
    this.sessions.delete(key);

    const { name, description, steps } = session.data;
    const yaml = [
      '---',
      `name: ${name}`,
      'steps:',
      ...steps.flatMap((s) => [
        '  - type: agent',
        `    agent: ${s.agent}`,
        `    action: ${s.action}`,
      ]),
      'outputChannel:',
      '  platform: slack',
      `  id: ${channel}`,
      '---',
      description || `${name} workflow.`,
      '',
    ].join('\n');

    try {
      fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
      fs.writeFileSync(path.join(WORKFLOWS_DIR, `${name}.md`), yaml, 'utf8');
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      await say({ text: `❌ Could not save workflow: \`${m}\``, thread_ts: thread_ts || ts });
      return;
    }

    const stepList = steps.map((s, i) => `  ${i + 1}. *${s.agent}* / _${s.action}_`).join('\n');
    await say({
      text: [
        `✅ *Workflow created:* \`${name}\``,
        stepList,
        '',
        `Run it with \`workflows run ${name}\`.`,
      ].join('\n'),
      thread_ts: thread_ts || ts,
    });
  }
}
