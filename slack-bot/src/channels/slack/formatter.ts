import { ChannelFormatter, ToolEvent, Platform } from '../../orchestration/types';

export class SlackFormatter implements ChannelFormatter {
  readonly platform: Platform = 'slack';

  formatToolUse(event: ToolEvent): string {
    switch (event.kind) {
      case 'bash':
        return `🖥️ *Running command:*\n\`\`\`bash\n${event.command}\n\`\`\``;

      case 'read':
        return `👁️ *Reading \`${event.path}\`*`;

      case 'edit': {
        // summary field contains "old → new" or "N edit(s)"
        const parts = event.summary.split(' → ');
        if (parts.length === 2) {
          return `📝 *Editing \`${event.path}\`*\n\`\`\`diff\n- ${parts[0]}\n+ ${parts[1]}\n\`\`\``;
        }
        return `📝 *Editing \`${event.path}\`*\n${event.summary}`;
      }

      case 'write':
        return `📄 *Creating \`${event.path}\`*`;

      case 'glob':
        return `🔍 *Searching \`${event.pattern}\`*`;

      case 'grep':
        return `🔍 *Searching for \`${event.pattern}\`*`;

      case 'web_search':
        return `🌐 *Searching: ${event.query}*`;

      case 'web_fetch':
        return `🌐 *Fetching: ${event.url}*`;

      case 'mcp':
        return `🔧 *${event.server}: ${event.tool}*`;

      case 'todo':
        return ''; // handled separately by message processor

      case 'unknown':
        return `🔧 *Using ${event.rawName}*`;

      default:
        return '';
    }
  }

  formatMessage(text: string): string {
    return text
      .replace(/```(\w+)?\n([\s\S]*?)```/g, (_: string, _lang: string, code: string) => '```' + code + '```')
      .replace(/`([^`]+)`/g, '`$1`')
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/__([^_]+)__/g, '_$1_');
  }
}
