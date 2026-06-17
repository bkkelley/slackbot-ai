import dotenv from 'dotenv';
import path from 'path';

dotenv.config();
dotenv.config({ path: path.join(process.cwd(), '../.env') });

export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
  },
  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN || '',
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
  claude: {
    useBedrock: process.env.CLAUDE_CODE_USE_BEDROCK === '1',
    useVertex: process.env.CLAUDE_CODE_USE_VERTEX === '1',
  },
  baseDirectory: process.env.BASE_DIRECTORY || `${process.env.HOME}/claude-workspaces`,
  debug: process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development',
  botHttpPort: parseInt(process.env.BOT_HTTP_PORT || '3458', 10),
  runtimeHttpPort: parseInt(process.env.RUNTIME_HTTP_PORT || '3457', 10),
  botRuntimeSharedSecret: process.env.BOT_RUNTIME_SHARED_SECRET || '',
  managementApiToken: process.env.MANAGEMENT_API_TOKEN || '',
};

export function validateConfig() {
  // SLACK_SIGNING_SECRET is only needed for the HTTP events receiver. In Socket
  // Mode (used here) the app token authenticates the websocket, so it's optional.
  const required = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
