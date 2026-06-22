import { App } from '@slack/bolt';
import { config, validateConfig } from './config';
import { ClaudeHandler } from './claude-handler';
import { McpManager } from './orchestration/mcp-manager';
import { PermissionIpcServer } from './permission-ipc-server';
import { Logger } from './logger';
import { SlackTransport } from './channels/slack/transport';
import { SlackFormatter } from './channels/slack/formatter';
import { DiscordTransport } from './channels/discord/transport';
import { DiscordFormatter } from './channels/discord/formatter';
import { MessageProcessor } from './orchestration/message-processor';
import { RuntimeApiServer } from './runtime-api/server';

const logger = new Logger('Main');

async function start() {
  try {
    validateConfig();

    logger.info('Starting Claude Code Slack bot', {
      debug: config.debug,
      useBedrock: config.claude.useBedrock,
      useVertex: config.claude.useVertex,
    });

    // Start permission IPC server (used for interactive permission prompts)
    const permissionIpcServer = new PermissionIpcServer(config.slack.botToken);
    const ipcPort = await permissionIpcServer.start();

    // Initialize Slack app
    const app = new App({
      token: config.slack.botToken,
      signingSecret: config.slack.signingSecret,
      socketMode: true,
      appToken: config.slack.appToken,
    });

    // Initialize MCP manager
    const mcpManager = new McpManager();
    const mcpConfig = mcpManager.loadConfiguration();

    // Initialize Claude handler
    const claudeHandler = new ClaudeHandler(mcpManager, ipcPort);

    // Slack transport + formatter → message processor
    const transport = new SlackTransport(app, config.slack.botToken, config.slack.userToken);
    const formatter = new SlackFormatter();
    const processor = new MessageProcessor(transport, formatter, claudeHandler, mcpManager);

    // Register message handler
    transport.onMessage(async (msg) => {
      await processor.handleMessage(msg);
    });

    // Channel join welcome message
    transport.setChannelJoinHandler(async (channelId) => {
      try {
        const channelInfo = await app.client.conversations.info({ channel: channelId });
        const channelName = (channelInfo.channel as any)?.name || 'this channel';

        let welcomeMessage = `👋 Hi! I'm Claude Code, your AI coding assistant.\n\n`;
        welcomeMessage += `Mention me here and I'll get to work. By default I operate in the *general* workspace.\n\n`;
        welcomeMessage += `To tie #${channelName} to a specific project, map it:\n`;
        welcomeMessage += `• \`project map <name>\` — a folder under \`${config.baseDirectory || '~/claude-workspaces'}\`, or an absolute path\n`;
        welcomeMessage += `• \`project\` shows the current mapping · \`project unmap\` clears it\n\n`;
        welcomeMessage += `Once mapped, I'll run in that project's directory for everything in this channel. \`help\` for more.`;

        await transport.send(channelId, undefined, welcomeMessage);
        logger.info('Sent welcome message to channel', { channelId, channelName });
      } catch (error) {
        logger.error('Failed to handle channel join', error);
      }
    });

    // Auto-create workspace folder when a Slack channel is created
    transport.setChannelCreatedHandler(async (channelName) => {
      try {
        const response = await fetch('http://localhost:3456/agents/api/projects', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.managementApiToken ? { 'x-management-auth': config.managementApiToken } : {}),
          },
          body: JSON.stringify({ name: channelName }),
        });
        if (response.status === 201) {
          logger.info('Created workspace for new channel', { channelName });
        } else if (response.status === 409) {
          logger.info('Workspace already exists for channel', { channelName });
        } else {
          const body = await response.json();
          logger.error('Failed to create workspace for channel', { channelName, status: response.status, body });
        }
      } catch (error) {
        logger.error('Error creating workspace for channel', { channelName, error });
      }
    });

    // Wire permission approval actions (Slack-specific interactive components)
    transport.setPermissionActionHandlers(
      async (approvalId, clickingUserId, respond) => {
        logger.info('Tool approval button clicked', { approvalId, clickingUserId });
        const result = permissionIpcServer.resolveApproval(approvalId, true, clickingUserId);
        if (result === 'unauthorized') {
          await respond({ response_type: 'ephemeral', text: '⛔ Only the user who triggered this request can approve it.' });
        } else if (result === 'not_found') {
          await respond({ response_type: 'ephemeral', text: '⚠️ This request has already been resolved or timed out.' });
        } else {
          await respond({ response_type: 'ephemeral', text: '✅ Tool execution approved.' });
        }
      },
      async (approvalId, clickingUserId, respond) => {
        logger.info('Tool denial button clicked', { approvalId, clickingUserId });
        const result = permissionIpcServer.resolveApproval(approvalId, false, clickingUserId);
        if (result === 'unauthorized') {
          await respond({ response_type: 'ephemeral', text: '⛔ Only the user who triggered this request can deny it.' });
        } else if (result === 'not_found') {
          await respond({ response_type: 'ephemeral', text: '⚠️ This request has already been resolved or timed out.' });
        } else {
          await respond({ response_type: 'ephemeral', text: '❌ Tool execution denied.' });
        }
      }
    );

    transport.setWorkflowApprovalActionHandlers(
      async (approvalId, clickingUserId, respond) => {
        logger.info('Workflow approval button clicked', { approvalId, clickingUserId });
        const response = await fetch(`http://127.0.0.1:${config.runtimeHttpPort}/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Auth': config.botRuntimeSharedSecret,
          },
          body: JSON.stringify({ resolvedBy: clickingUserId, comment: 'Approved from Slack' }),
        });
        if (response.status === 404) {
          await respond({ response_type: 'ephemeral', text: '⚠️ This workflow approval was not found.' });
        } else if (!response.ok) {
          await respond({ response_type: 'ephemeral', text: `⚠️ Approval failed: ${response.status}` });
        } else {
          await respond({ response_type: 'ephemeral', text: '✅ Workflow approved.' });
        }
      },
      async (approvalId, clickingUserId, respond) => {
        logger.info('Workflow denial button clicked', { approvalId, clickingUserId });
        const response = await fetch(`http://127.0.0.1:${config.runtimeHttpPort}/api/approvals/${encodeURIComponent(approvalId)}/deny`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Auth': config.botRuntimeSharedSecret,
          },
          body: JSON.stringify({ resolvedBy: clickingUserId, comment: 'Denied from Slack' }),
        });
        if (response.status === 404) {
          await respond({ response_type: 'ephemeral', text: '⚠️ This workflow approval was not found.' });
        } else if (!response.ok) {
          await respond({ response_type: 'ephemeral', text: `⚠️ Denial failed: ${response.status}` });
        } else {
          await respond({ response_type: 'ephemeral', text: '❌ Workflow denied.' });
        }
      }
    );

    // Start Slack
    await app.start();
    logger.info('⚡️ Claude Code Slack bot is running!');
    logger.info('Configuration:', {
      usingBedrock: config.claude.useBedrock,
      usingVertex: config.claude.useVertex,
      usingAnthropicAPI: !config.claude.useBedrock && !config.claude.useVertex,
      debugMode: config.debug,
      baseDirectory: config.baseDirectory || 'not set',
      mcpServers: mcpConfig ? Object.keys(mcpConfig.mcpServers).length : 0,
      permissionIpcPort: ipcPort,
      botHttpPort: config.botHttpPort,
    });

    // Start runtime API (Slack transport registered by default)
    const runtimeApi = new RuntimeApiServer(config.botHttpPort, config.botRuntimeSharedSecret, transport);

    // Optionally start Discord transport
    if (config.discord.botToken) {
      const discordTransport = new DiscordTransport(config.discord.botToken);
      const discordFormatter = new DiscordFormatter();
      const discordProcessor = new MessageProcessor(discordTransport, discordFormatter, claudeHandler, mcpManager);

      discordTransport.onMessage(async (msg) => {
        await discordProcessor.handleMessage(msg);
      });

      await discordTransport.start();
      runtimeApi.registerTransport(discordTransport);
      logger.info('Discord transport started');
    } else {
      logger.info('DISCORD_BOT_TOKEN not set — Discord transport disabled');
    }

    await runtimeApi.start();

    // Graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM, shutting down');
      permissionIpcServer.close();
      runtimeApi.close();
      process.exit(0);
    });
    process.on('SIGINT', () => {
      logger.info('Received SIGINT, shutting down');
      permissionIpcServer.close();
      runtimeApi.close();
      process.exit(0);
    });
  } catch (error) {
    logger.error('Failed to start the bot', error);
    process.exit(1);
  }
}

start();
