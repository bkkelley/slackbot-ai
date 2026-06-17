import {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  TextChannel,
  NewsChannel,
  ThreadChannel,
  DMChannel,
  Message,
  Attachment,
  Partials,
} from 'discord.js';
import { ChannelTransport, IncomingMessage, PlatformFile, Platform, SentMessage } from '../../orchestration/types';
import { Logger } from '../../logger';

type SendableChannel = TextChannel | NewsChannel | ThreadChannel | DMChannel;

// Maps Slack-style emoji names to Unicode for Discord reactions
const EMOJI_MAP: Record<string, string> = {
  eyes: '👀',
  white_check_mark: '✅',
  x: '❌',
  hourglass_flowing_sand: '⏳',
  warning: '⚠️',
  rotating_light: '🚨',
  memo: '📝',
  robot_face: '🤖',
  thinking_face: '🤔',
  gear: '⚙️',
  checkered_flag: '🏁',
};

function toDiscordEmoji(emoji: string): string {
  return EMOJI_MAP[emoji] ?? emoji;
}

// Discord has a 2000 char message limit
const MAX_LENGTH = 1990;

function splitMessage(text: string): string[] {
  if (text.length <= MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_LENGTH) {
    // Try to split at a newline
    let cut = remaining.lastIndexOf('\n', MAX_LENGTH);
    if (cut <= 0) cut = MAX_LENGTH;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export class DiscordTransport implements ChannelTransport {
  readonly platform: Platform = 'discord';

  private client: Client;
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private logger = new Logger('DiscordTransport');
  private botUserId: string | null = null;

  constructor(private readonly botToken: string) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, (c) => {
        this.botUserId = c.user.id;
        this.logger.info(`Discord bot ready as ${c.user.tag}`, { userId: c.user.id });
        resolve();
      });
      this.client.once(Events.Error, reject);
      this.client.login(this.botToken).catch(reject);
    });
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;

    this.client.on(Events.MessageCreate, async (message: Message) => {
      if (message.author.bot) return;

      const isDM = message.channel.type === ChannelType.DM;
      const isThread =
        message.channel.type === ChannelType.PublicThread ||
        message.channel.type === ChannelType.PrivateThread ||
        message.channel.type === ChannelType.AnnouncementThread;
      const botMentioned = this.botUserId !== null && message.mentions.has(this.botUserId);

      // Respond when: mentioned, DM, or any thread (threads imply an active conversation)
      if (!botMentioned && !isDM && !isThread) return;

      // Strip all bot mentions from text
      const text = message.content.replace(/<@!?\d+>/g, '').trim();

      const files: PlatformFile[] | undefined =
        message.attachments.size > 0
          ? [...message.attachments.values()].map((att: Attachment) => ({
              name: att.name,
              mimeType: att.contentType || 'application/octet-stream',
              size: att.size,
              ref: { url: att.url, token: this.botToken },
            }))
          : undefined;

      // For Discord, channelId IS the thread channel ID when in a thread.
      // threadId = undefined keeps session keys clean; each Discord thread is its own "channel".
      const channelId = message.channelId;

      await handler({
        platform: 'discord',
        channelId,
        threadId: undefined,
        messageId: message.id,
        userId: message.author.id,
        text,
        files: files && files.length > 0 ? files : undefined,
        isDM,
      });
    });
  }

  setChannelJoinHandler(_handler: (channelId: string) => Promise<void>): void {
    // Discord doesn't fire a clean "bot added to channel" event for text channels.
  }

  setPermissionActionHandlers(
    _onApprove: (approvalId: string, userId: string, respond: any) => Promise<void>,
    _onDeny: (approvalId: string, userId: string, respond: any) => Promise<void>
  ): void {
    // Discord uses bypass permissions — no approval buttons needed.
  }

  async send(channelId: string, _threadId: string | undefined, text: string): Promise<SentMessage> {
    const channel = await this.fetchChannel(channelId);
    const chunks = splitMessage(text);
    let lastId = '';
    for (const chunk of chunks) {
      const msg = await channel.send(chunk);
      lastId = msg.id;
    }
    return { messageId: lastId };
  }

  async update(channelId: string, messageId: string, text: string): Promise<void> {
    const channel = await this.fetchChannel(channelId);
    const msg = await channel.messages.fetch(messageId);
    const chunks = splitMessage(text);
    // Edit the original message with first chunk; send additional chunks if needed
    await msg.edit(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await channel.send(chunks[i]);
    }
  }

  async uploadFile(channelId: string, _threadId: string | undefined, file: Buffer, filename: string): Promise<void> {
    const channel = await this.fetchChannel(channelId);
    await channel.send({ files: [{ attachment: file, name: filename }] });
  }

  async downloadFile(file: PlatformFile): Promise<Buffer> {
    const { url } = file.ref as { url: string; token: string };
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Discord file download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  supports(capability: 'reactions'): boolean {
    return capability === 'reactions';
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.fetchChannel(channelId);
    const msg = await channel.messages.fetch(messageId);
    await msg.react(toDiscordEmoji(emoji));
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.botUserId) return;
    const channel = await this.fetchChannel(channelId);
    const msg = await channel.messages.fetch(messageId);
    const mapped = toDiscordEmoji(emoji);
    const reaction = msg.reactions.cache.find(
      (r) => r.emoji.name === mapped || r.emoji.toString() === mapped
    );
    if (reaction) await reaction.users.remove(this.botUserId);
  }

  private async fetchChannel(channelId: string): Promise<SendableChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) throw new Error(`Discord channel not found: ${channelId}`);
    return channel as SendableChannel;
  }
}
