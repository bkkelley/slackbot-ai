import { ChannelTransport, IncomingMessage, PlatformFile, Platform, SentMessage } from '../types';

export interface RecordedCall {
  method: string;
  args: unknown[];
  at: Date;
}

export class FakeTransport implements ChannelTransport {
  readonly platform: Platform = 'fake';
  readonly calls: RecordedCall[] = [];
  private handlers: Array<(msg: IncomingMessage) => Promise<void>> = [];
  private messageCounter = 0;

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args, at: new Date() });
  }

  /** Simulate an incoming message — triggers all registered onMessage handlers. */
  async inject(msg: IncomingMessage): Promise<void> {
    for (const handler of this.handlers) {
      await handler(msg);
    }
  }

  /** Clear the recorded calls array (does not remove handlers). */
  reset(): void {
    this.calls.length = 0;
  }

  async start(): Promise<void> {
    this.record('start', []);
  }

  async stop(): Promise<void> {
    this.record('stop', []);
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handlers.push(handler);
    this.record('onMessage', []);
  }

  async send(channelId: string, threadId: string | undefined, text: string): Promise<SentMessage> {
    this.record('send', [channelId, threadId, text]);
    const messageId = `fake-msg-${++this.messageCounter}`;
    return { messageId };
  }

  async update(channelId: string, messageId: string, text: string): Promise<void> {
    this.record('update', [channelId, messageId, text]);
  }

  async uploadFile(
    channelId: string,
    threadId: string | undefined,
    file: Buffer,
    filename: string,
  ): Promise<void> {
    this.record('uploadFile', [channelId, threadId, file.length, filename]);
  }

  async downloadFile(file: PlatformFile): Promise<Buffer> {
    this.record('downloadFile', [file]);
    return Buffer.alloc(0);
  }

  supports(_capability: 'reactions'): boolean {
    return true;
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.record('react', [channelId, messageId, emoji]);
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.record('removeReaction', [channelId, messageId, emoji]);
  }
}
