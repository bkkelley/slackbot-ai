export type Platform = 'slack' | 'discord' | (string & {});

export interface IncomingMessage {
  platform: Platform;
  channelId: string;
  threadId?: string;
  messageId: string;
  userId: string;
  text?: string;
  files?: PlatformFile[];
  isDM: boolean;
}

export interface PlatformFile {
  name: string;
  mimeType: string;
  size: number;
  ref: unknown;
}

export interface SentMessage {
  messageId: string;
}

export interface CreatedCanvas {
  canvasId: string;
  permalink?: string;
}

export interface ScheduledMessage {
  scheduledMessageId: string;
  postAt: number;
}

export interface ScheduledMessageSummary {
  id: string;
  channelId: string;
  postAt: number;
  text?: string;
}

export interface CreatedReminder {
  reminderId: string;
}

export interface CreatedTaskList {
  listId: string;
  primaryColumnId?: string;
  permalink?: string;
}

export interface CreatedTask {
  itemId: string;
}

export interface TaskItem {
  id: string;
  text: string;
}

export interface SlackSearchHit {
  text: string;
  user: string;
  ts: string;
  channelId: string;
  channelName: string;
  permalink: string;
}

export interface SlackChannelMessage {
  text: string;
  user: string;
  ts: string;
}

export interface ChannelTransport {
  readonly platform: Platform;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;
  send(channelId: string, threadId: string | undefined, text: string): Promise<SentMessage>;
  sendWorkflowApproval?(channelId: string, threadId: string | undefined, approvalId: string, prompt: string): Promise<SentMessage>;
  update(channelId: string, messageId: string, text: string): Promise<void>;
  uploadFile(channelId: string, threadId: string | undefined, file: Buffer, filename: string): Promise<void>;
  downloadFile(file: PlatformFile): Promise<Buffer>;
  supports(capability: 'reactions'): boolean;
  react?(channelId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction?(channelId: string, messageId: string, emoji: string): Promise<void>;

  // Canvas (Slack-only; optional per transport)
  createCanvas?(title: string, markdown: string, channelId?: string, grantUserId?: string): Promise<CreatedCanvas>;
  editCanvas?(canvasId: string, markdown: string): Promise<void>;

  // Scheduled messages (Slack-only; optional per transport)
  scheduleMessage?(channelId: string, threadId: string | undefined, text: string, postAt: number): Promise<ScheduledMessage>;
  listScheduledMessages?(channelId?: string): Promise<ScheduledMessageSummary[]>;
  cancelScheduledMessage?(channelId: string, scheduledMessageId: string): Promise<void>;

  // Native reminders (Slack-only; optional per transport)
  addReminder?(userId: string, text: string, time: string | number): Promise<CreatedReminder>;

  // Lists / tasks (Slack-only; optional per transport; requires a paid plan)
  createTaskList?(name: string, grantUserId?: string): Promise<CreatedTaskList>;
  addTask?(listId: string, text: string, columnId?: string): Promise<CreatedTask>;
  listTasks?(listId: string): Promise<TaskItem[]>;

  // Read-as-the-owner via a user token (Slack-only; optional; needs SLACK_USER_TOKEN)
  searchMessages?(query: string, count?: number): Promise<SlackSearchHit[]>;
  readChannelMessages?(channelId: string, limit?: number): Promise<SlackChannelMessage[]>;
}

export type ToolEvent =
  | { kind: 'bash'; command: string; cwd?: string }
  | { kind: 'read'; path: string; range?: [number, number] }
  | { kind: 'edit'; path: string; summary: string }
  | { kind: 'write'; path: string; bytes: number }
  | { kind: 'glob'; pattern: string; cwd?: string }
  | { kind: 'grep'; pattern: string; path?: string }
  | { kind: 'web_search'; query: string }
  | { kind: 'web_fetch'; url: string }
  | { kind: 'mcp'; server: string; tool: string; summary: string }
  | { kind: 'todo'; action: 'add' | 'update' | 'complete'; summary: string }
  | { kind: 'unknown'; rawName: string; summary: string };

export interface ChannelFormatter {
  readonly platform: Platform;
  formatToolUse(event: ToolEvent): string;
  formatMessage(text: string): string;
}
