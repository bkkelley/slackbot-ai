import { ChannelTransport } from '../types';
import { Logger } from '../../logger';
import { CommandContext } from './types';

/**
 * $tasks — manage Slack Lists (tasks) from Slack. Requires lists:write/lists:read scopes and a
 * PAID Slack plan. Stateless: operates on explicit list IDs (returned by `$tasks create`).
 * Per-channel default-list mapping is a future enhancement.
 */
export class TasksCommand {
  private logger = new Logger('TasksCommand');

  constructor(private transport: ChannelTransport) {}

  async handle(ctx: CommandContext): Promise<boolean> {
    const { text, thread_ts, ts, say } = ctx;
    const trimmed = text.trim();
    if (!/^\$tasks(\s+.*)?$/i.test(trimmed)) return false;

    const sub = trimmed.replace(/^\$tasks\s*/i, '').trim();

    if (!this.transport.createTaskList || !this.transport.addTask || !this.transport.listTasks) {
      await say({ text: '❌ Tasks (Slack Lists) aren’t supported on this transport.', thread_ts: thread_ts || ts });
      return true;
    }

    const createMatch = sub.match(/^create\s+(.+)$/i);
    if (createMatch) {
      try {
        const result = await this.transport.createTaskList(createMatch[1].trim(), ctx.user);
        const link = result.permalink ? `\n🔗 ${result.permalink}` : '';
        await say({
          text: `✅ Created list *${createMatch[1].trim()}*.${link}\nList ID: \`${result.listId}\`\n\nAdd to it with \`$tasks add ${result.listId} <task>\`.`,
          thread_ts: thread_ts || ts,
        });
      } catch (err) {
        await say({ text: `❌ Could not create list: \`${this.msg(err)}\``, thread_ts: thread_ts || ts });
      }
      return true;
    }

    const addMatch = sub.match(/^add\s+(\S+)\s+(.+)$/i);
    if (addMatch) {
      try {
        await this.transport.addTask(addMatch[1], addMatch[2].trim());
        await say({ text: `✅ Added task to \`${addMatch[1]}\`.`, thread_ts: thread_ts || ts });
      } catch (err) {
        await say({ text: `❌ Could not add task: \`${this.msg(err)}\``, thread_ts: thread_ts || ts });
      }
      return true;
    }

    const listMatch = sub.match(/^list\s+(\S+)$/i);
    if (listMatch) {
      try {
        const items = await this.transport.listTasks(listMatch[1]);
        if (items.length === 0) {
          await say({ text: `📭 No tasks in \`${listMatch[1]}\`.`, thread_ts: thread_ts || ts });
        } else {
          const formatted = items.map((i) => `• ${i.text}`).join('\n');
          await say({ text: `*Tasks in \`${listMatch[1]}\`:*\n${formatted}`, thread_ts: thread_ts || ts });
        }
      } catch (err) {
        await say({ text: `❌ Could not list tasks: \`${this.msg(err)}\``, thread_ts: thread_ts || ts });
      }
      return true;
    }

    await say({
      text: [
        '*$tasks commands* _(Slack Lists — requires a paid plan)_:',
        '`$tasks create <name>` — create a task list (returns its ID)',
        '`$tasks add <listId> <task>` — add a task',
        '`$tasks list <listId>` — show tasks in a list',
      ].join('\n'),
      thread_ts: thread_ts || ts,
    });
    return true;
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
