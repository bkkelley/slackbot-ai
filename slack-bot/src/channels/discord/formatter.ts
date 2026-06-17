import { ChannelFormatter, ToolEvent, Platform } from '../../orchestration/types';

export class DiscordFormatter implements ChannelFormatter {
  readonly platform: Platform = 'discord';

  formatToolUse(event: ToolEvent): string {
    switch (event.kind) {
      case 'bash':
        return `🖥️ **Running command:**\n\`\`\`bash\n${event.command}\n\`\`\``;

      case 'read':
        return `👁️ **Reading \`${event.path}\`**`;

      case 'edit': {
        const parts = event.summary.split(' → ');
        if (parts.length === 2) {
          return `📝 **Editing \`${event.path}\`**\n\`\`\`diff\n- ${parts[0]}\n+ ${parts[1]}\n\`\`\``;
        }
        return `📝 **Editing \`${event.path}\`** — ${event.summary}`;
      }

      case 'write':
        return `📄 **Creating \`${event.path}\`**`;

      case 'glob':
        return `🔍 **Searching \`${event.pattern}\`**`;

      case 'grep':
        return `🔍 **Searching for \`${event.pattern}\`**`;

      case 'web_search':
        return `🌐 **Searching:** ${event.query}`;

      case 'web_fetch':
        return `🌐 **Fetching:** ${event.url}`;

      case 'mcp':
        return `🔧 **${event.server}: ${event.tool}**`;

      case 'todo':
        return ''; // handled separately by message processor

      case 'unknown':
        return `🔧 **Using ${event.rawName}**`;

      default:
        return '';
    }
  }

  formatMessage(text: string): string {
    // Discord uses standard Markdown — pass through mostly unchanged.
    // Convert Slack-specific mrkdwn: *bold* → **bold**, _italic_ stays as-is
    return text
      .replace(/\*([^*]+)\*/g, '**$1**') // *text* → **text** (Slack bold → Discord bold)
      .replace(/`([^`]+)`/g, '`$1`'); // inline code unchanged
  }
}
