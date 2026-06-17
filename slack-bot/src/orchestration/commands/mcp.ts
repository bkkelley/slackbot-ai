import { McpManager } from '../mcp-manager';
import { CommandContext } from './types';

export class McpCommand {
  constructor(private mgr: McpManager) {}

  async handle(ctx: CommandContext): Promise<boolean> {
    const { text, channel, thread_ts, ts, say } = ctx;

    if (/^(mcp|servers?)(\s+(info|list|status))?(\?)?$/i.test(text.trim())) {
      await say({ text: this.mgr.formatMcpInfo(), thread_ts: thread_ts || ts });
      return true;
    }

    if (/^(mcp|servers?)\s+(reload|refresh)$/i.test(text.trim())) {
      const reloaded = this.mgr.reloadConfiguration();
      await say({
        text: reloaded
          ? `✅ MCP configuration reloaded successfully.\n\n${this.mgr.formatMcpInfo()}`
          : `❌ Failed to reload MCP configuration. Check the mcp-servers.json file.`,
        thread_ts: thread_ts || ts,
      });
      return true;
    }

    return false;
  }
}
