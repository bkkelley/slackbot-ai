import * as fs from 'fs';
import { Logger } from './logger.js';

const logger = new Logger('agent-channels');
const CHANNELS_FILE =
  process.env.AGENT_CHANNELS_FILE ||
  `${process.env.HOME}/claude-workspaces/system/agent-runtime/agent-channels.json`;

export interface AgentChannelMapping {
  agent: string;
}

function ensureFile(): void {
  if (!fs.existsSync(CHANNELS_FILE)) {
    const sageChannel = process.env.SAGE_CHANNEL;
    const initial: Record<string, AgentChannelMapping> = {};
    if (sageChannel) {
      initial[`slack:${sageChannel}`] = { agent: 'Sage' };
    }
    try {
      fs.writeFileSync(CHANNELS_FILE, JSON.stringify(initial, null, 2), 'utf8');
      logger.info('Created agent-channels.json', { path: CHANNELS_FILE });
    } catch (err) {
      logger.warn('Could not create agent-channels.json', { error: String(err) });
    }
  }
}

export function loadChannels(): Record<string, AgentChannelMapping> {
  ensureFile();
  try {
    const raw = fs.readFileSync(CHANNELS_FILE, 'utf8');
    return JSON.parse(raw) as Record<string, AgentChannelMapping>;
  } catch (err) {
    logger.warn('Could not load agent-channels.json', { error: String(err) });
    return {};
  }
}

export function saveChannels(channels: Record<string, AgentChannelMapping>): void {
  try {
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2), 'utf8');
  } catch (err) {
    logger.error('Could not save agent-channels.json', { error: String(err) });
  }
}

export function getAgentForChannel(platformChannelKey: string): string | null {
  const channels = loadChannels();
  return channels[platformChannelKey]?.agent ?? null;
}
