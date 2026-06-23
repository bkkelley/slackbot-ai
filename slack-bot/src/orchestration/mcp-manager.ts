import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logger';

export type McpStdioServerConfig = {
  type?: 'stdio'; // Optional for backwards compatibility
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpSSEServerConfig = {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
};

export type McpHttpServerConfig = {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
};

export type McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig;

export interface McpConfiguration {
  mcpServers: Record<string, McpServerConfig>;
}

export class McpManager {
  private logger = new Logger('McpManager');
  private config: McpConfiguration | null = null;
  private configPath: string;

  constructor(configPath: string = './mcp-servers.json') {
    this.configPath = path.resolve(configPath);
  }

  loadConfiguration(): McpConfiguration | null {
    if (this.config) {
      return this.config;
    }

    try {
      if (!fs.existsSync(this.configPath)) {
        this.logger.info('No MCP configuration file found', { path: this.configPath });
        return null;
      }

      const configContent = fs.readFileSync(this.configPath, 'utf-8');
      const parsedConfig = JSON.parse(configContent);

      if (!parsedConfig.mcpServers || typeof parsedConfig.mcpServers !== 'object') {
        this.logger.warn('Invalid MCP configuration: missing or invalid mcpServers', { path: this.configPath });
        return null;
      }

      // Validate server configurations
      for (const [serverName, serverConfig] of Object.entries(parsedConfig.mcpServers)) {
        if (!this.validateServerConfig(serverName, serverConfig as McpServerConfig)) {
          this.logger.warn('Invalid server configuration, skipping', { serverName });
          delete parsedConfig.mcpServers[serverName];
        }
      }

      this.config = parsedConfig as McpConfiguration;

      this.logger.info('Loaded MCP configuration', {
        path: this.configPath,
        serverCount: Object.keys(this.config.mcpServers).length,
        servers: Object.keys(this.config.mcpServers),
      });

      return this.config;
    } catch (error) {
      this.logger.error('Failed to load MCP configuration', error);
      return null;
    }
  }

  private validateServerConfig(serverName: string, config: McpServerConfig): boolean {
    if (!config || typeof config !== 'object') {
      return false;
    }

    // Validate based on type
    if (!config.type || config.type === 'stdio') {
      // Stdio server
      const stdioConfig = config as McpStdioServerConfig;
      if (!stdioConfig.command || typeof stdioConfig.command !== 'string') {
        this.logger.warn('Stdio server missing command', { serverName });
        return false;
      }
    } else if (config.type === 'sse' || config.type === 'http') {
      // SSE or HTTP server
      const urlConfig = config as McpSSEServerConfig | McpHttpServerConfig;
      if (!urlConfig.url || typeof urlConfig.url !== 'string') {
        this.logger.warn('SSE/HTTP server missing URL', { serverName, type: config.type });
        return false;
      }
      // Only allow http/https URLs to prevent file:// or other unexpected schemes
      try {
        const parsed = new URL(urlConfig.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          this.logger.warn('SSE/HTTP server URL must use http or https', { serverName, url: urlConfig.url });
          return false;
        }
      } catch {
        this.logger.warn('SSE/HTTP server URL is invalid', { serverName, url: urlConfig.url });
        return false;
      }
    } else {
      this.logger.warn('Unknown server type', { serverName, type: config.type });
      return false;
    }

    return true;
  }

  getServerConfiguration(): Record<string, McpServerConfig> | undefined {
    const config = this.loadConfiguration();
    return config?.mcpServers;
  }

  getDefaultAllowedTools(): string[] {
    const config = this.loadConfiguration();
    if (!config) {
      return [];
    }

    // Allow all tools from all configured servers by default
    return Object.keys(config.mcpServers).map(serverName => `mcp__${serverName}`);
  }

  // The built-in MCP servers the bot wires into every interactive Slack session in code (see
  // claude-handler.ts). These power the bot's own capabilities and are NOT listed in
  // mcp-servers.json — without surfacing them here, `mcp` looks like nothing is configured.
  private builtinServers(): { name: string; desc: string }[] {
    const servers = [
      { name: 'system-control', desc: 'run/list agents, workflows, jobs, schedules, projects' },
      { name: 'slack-tools', desc: 'canvases, scheduled messages, reminders, SearchMessages/ReadChannelMessages' },
      { name: 'permission-prompt', desc: 'tool-approval flow' },
    ];
    if (process.env.MEMORY_ENABLED === 'true') {
      servers.push({ name: 'mempalace', desc: 'long-term memory (MEMORY_ENABLED)' });
    }
    if (process.env.SLACK_MCP_ENABLED === 'true') {
      servers.push({ name: 'slack', desc: 'hosted Slack MCP (SLACK_MCP_ENABLED)' });
    }
    return servers;
  }

  formatMcpInfo(): string {
    let info = '🔧 *Built-in MCP servers* (always on, wired in code):\n';
    for (const s of this.builtinServers()) {
      info += `• \`${s.name}\` — ${s.desc}\n`;
    }

    const config = this.loadConfiguration();
    const external = config ? Object.entries(config.mcpServers) : [];
    info += '\n*External MCP servers* (from `mcp-servers.json`):\n';
    if (external.length === 0) {
      info += '• _none configured_ — add servers to `mcp-servers.json`, then run `mcp reload`.\n';
      return info.trimEnd();
    }

    for (const [serverName, serverConfig] of external) {
      const type = serverConfig.type || 'stdio';
      info += `• *${serverName}* (${type})\n`;
      if (type === 'stdio') {
        const stdioConfig = serverConfig as McpStdioServerConfig;
        info += `  Command: \`${stdioConfig.command}\`\n`;
        if (stdioConfig.args && stdioConfig.args.length > 0) {
          info += `  Args: \`${stdioConfig.args.join(' ')}\`\n`;
        }
      } else {
        const urlConfig = serverConfig as McpSSEServerConfig | McpHttpServerConfig;
        info += `  URL: \`${urlConfig.url}\`\n`;
      }
    }

    info += '\nTools follow the pattern `mcp__serverName__toolName`; all are allowed by default.';
    return info;
  }

  reloadConfiguration(): McpConfiguration | null {
    this.config = null;
    return this.loadConfiguration();
  }
}
