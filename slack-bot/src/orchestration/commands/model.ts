import { ModelManager, MODELS, DEFAULT_MODEL } from '../model-manager';
import { CommandContext } from './types';

export class ModelCommand {
  constructor(private mgr: ModelManager) {}

  async handle(ctx: CommandContext): Promise<boolean> {
    const { text, channel, thread_ts, ts, say } = ctx;
    const trimmed = text.trim();

    if (!/^model(\s.*)?$/i.test(trimmed)) return false;

    const arg = trimmed.replace(/^model\s*/i, '').trim();
    const scope = thread_ts ? 'this thread' : 'this channel';
    const threadTs = thread_ts || ts;

    if (!arg) {
      const current = this.mgr.get(channel, thread_ts);
      const label = this.mgr.label(current);
      const isDefault = current === DEFAULT_MODEL;
      await say({
        text: `Current model for ${scope}: \`${label}\`${isDefault ? ' _(default)_' : ''}\n\nAvailable: ${Object.keys(MODELS).map(k => `\`${k}\``).join(', ')}\nUsage: \`model sonnet\` or \`model haiku\``,
        thread_ts: threadTs,
      });
      return true;
    }

    if (arg === 'reset') {
      this.mgr.reset(channel, thread_ts);
      await say({ text: `✅ Model reset to default (\`${this.mgr.label(DEFAULT_MODEL)}\`) for ${scope}.`, thread_ts: threadTs });
      return true;
    }

    const result = this.mgr.set(channel, arg, thread_ts);
    if (!result.ok) {
      await say({ text: `❌ ${result.error}`, thread_ts: threadTs });
    } else {
      await say({ text: `✅ Model set to \`${this.mgr.label(result.model!)}\` for ${scope}.`, thread_ts: threadTs });
    }
    return true;
  }
}
