import { App } from '@slack/bolt';
import {
  ChannelTransport,
  IncomingMessage,
  PlatformFile,
  Platform,
  SentMessage,
  CreatedCanvas,
  ScheduledMessage,
  ScheduledMessageSummary,
  CreatedReminder,
  CreatedTaskList,
  CreatedTask,
  TaskItem,
} from '../../orchestration/types';
import { downloadSlackFile } from './file-downloader';
import { Logger } from '../../logger';
import { normalizeSlackReactionName } from './reactions';
import { buildHomeBlocks, privateHomeBlocks, buildMapModal } from './home-view';
import {
  loadChannelProjects,
  saveChannelProjects,
  sanitizeProject,
  addChannelToManifest,
  setSalesforce,
  setDrivePath,
  isSalesforceId,
} from '../../orchestration/channel-projects';

const OWNER_USER_ID = process.env.SLACK_OWNER_USER_ID || '';

interface SlackFileRef {
  url: string;
  token: string;
}

export class SlackTransport implements ChannelTransport {
  readonly platform: Platform = 'slack';

  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private channelJoinHandler: ((channelId: string) => Promise<void>) | null = null;
  private botUserId: string | null = null;
  private logger = new Logger('SlackTransport');

  constructor(private app: App, private botToken: string) {}

  async start(): Promise<void> {
    // no-op — app.start() is called externally
  }

  async stop(): Promise<void> {
    // no-op — bolt handles lifecycle
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;

    // Plain messages (no bot mention)
    this.app.message(async ({ message, say: _say }) => {
      if (message.subtype === undefined && 'user' in message) {
        const botUserId = await this.getBotUserId();
        const mentionsBot = 'text' in message && message.text?.includes(`<@${botUserId}>`);
        if (mentionsBot) return; // handled by app_mention

        this.logger.info('Handling message event');
        const event = message as any;
        await this.messageHandler!(this.convertEvent(event));
      }
    });

    // App mentions
    this.app.event('app_mention', async ({ event }) => {
      this.logger.info('Handling app mention event');
      const text = event.text.replace(/<@[^>]+>/g, '').trim();
      await this.messageHandler!(this.convertEvent({ ...event, text }));
    });

    // File shares
    this.app.event('message', async ({ event }) => {
      if (event.subtype === 'file_share' && 'user' in event && (event as any).files) {
        this.logger.info('Handling file upload event');
        await this.messageHandler!(this.convertEvent(event as any));
      }
    });

    // App Home tab
    this.app.event('app_home_opened', async ({ event, client }) => {
      if ((event as any).tab !== 'home') return; // ignore the Messages tab
      await this.publishHome(client, event.user);
    });

    // 🔄 Refresh → re-pull Outlook + re-publish
    this.app.action('home_refresh', async ({ ack, body, client }) => {
      await ack();
      await this.publishHome(client, (body as any).user.id);
    });

    // ➕ Add / change a mapping → open the modal
    this.app.action('home_add_mapping', async ({ ack, body, client }) => {
      await ack();
      try {
        await client.views.open({ trigger_id: (body as any).trigger_id, view: buildMapModal() as any });
      } catch (error) {
        this.logger.error('Failed to open map modal', error);
      }
    });

    // Unmap buttons (action_id = `home_unmap:<channelId>`)
    this.app.action(/^home_unmap:/, async ({ ack, body, client }) => {
      await ack();
      const cid = (body as any).actions?.[0]?.value as string;
      if (cid) {
        const map = loadChannelProjects();
        delete map[cid];
        try { saveChannelProjects(map); } catch (err) { this.logger.error('Unmap save failed', err); }
      }
      await this.publishHome(client, (body as any).user.id);
    });

    // Map modal submission
    this.app.view('home_map_submit', async ({ ack, body, view, client }) => {
      const values = (view.state.values || {}) as any;
      const cid = values.chan?.val?.selected_conversation as string | undefined;
      const picked = values.proj_select?.val?.selected_option?.value as string | undefined;
      const typed = values.proj_new?.val?.value as string | undefined;
      const project = sanitizeProject(typed || picked || '');
      if (!cid || !project) {
        await ack({
          response_action: 'errors',
          errors: { proj_new: 'Pick a channel and enter a valid project name or absolute path.' },
        } as any);
        return;
      }
      // Optional bindings
      const sfOrg = (values.sf_org?.val?.value || '').trim();
      const sfAccount = (values.sf_account?.val?.value || '').trim();
      const sfProject = (values.sf_project?.val?.value || '').trim();
      const drivePath = (values.drive_path?.val?.value || '').trim();
      if ((sfAccount && !isSalesforceId(sfAccount)) || (sfProject && !isSalesforceId(sfProject))) {
        await ack({
          response_action: 'errors',
          errors: { sf_account: 'Salesforce IDs must be 15 or 18 alphanumeric characters.' },
        } as any);
        return;
      }
      await ack();
      const map = loadChannelProjects();
      map[cid] = project;
      try {
        saveChannelProjects(map);
        addChannelToManifest(project, cid);
        if (sfOrg && sfAccount && sfProject) setSalesforce(project, sfOrg, sfAccount, sfProject);
        if (drivePath) setDrivePath(project, drivePath);
      } catch (err) {
        this.logger.error('Map save failed', err);
      }
      await this.publishHome(client, (body as any).user.id);
    });
  }

  // Publish the App Home tab, owner-locked. Non-owners see only a private notice.
  private async publishHome(client: any, userId: string): Promise<void> {
    try {
      const blocks = OWNER_USER_ID && userId !== OWNER_USER_ID ? privateHomeBlocks() : await buildHomeBlocks();
      await client.views.publish({ user_id: userId, view: { type: 'home', blocks: blocks as any } });
    } catch (error) {
      this.logger.error('Failed to publish App Home view', error);
    }
  }

  setChannelJoinHandler(handler: (channelId: string) => Promise<void>): void {
    this.channelJoinHandler = handler;

    this.app.event('member_joined_channel', async ({ event }) => {
      const botUserId = await this.getBotUserId();
      if (event.user === botUserId) {
        this.logger.info('Bot added to channel', { channel: event.channel });
        await this.channelJoinHandler!(event.channel);
      }
    });
  }

  setChannelCreatedHandler(handler: (channelName: string) => Promise<void>): void {
    this.app.event('channel_created', async ({ event }) => {
      const channelName = (event.channel as any).name as string;
      this.logger.info('Channel created', { channelName });
      await handler(channelName);
    });
  }

  setPermissionActionHandlers(
    onApprove: (approvalId: string, userId: string, respond: any) => Promise<void>,
    onDeny: (approvalId: string, userId: string, respond: any) => Promise<void>
  ): void {
    this.app.action('approve_tool', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value as string;
      const clickingUserId = (body as any).user?.id as string;
      await onApprove(approvalId, clickingUserId, respond);
    });

    this.app.action('deny_tool', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value as string;
      const clickingUserId = (body as any).user?.id as string;
      await onDeny(approvalId, clickingUserId, respond);
    });
  }

  setWorkflowApprovalActionHandlers(
    onApprove: (approvalId: string, userId: string, respond: any) => Promise<void>,
    onDeny: (approvalId: string, userId: string, respond: any) => Promise<void>
  ): void {
    this.app.action('approve_workflow', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value as string;
      const clickingUserId = (body as any).user?.id as string;
      await onApprove(approvalId, clickingUserId, respond);
    });

    this.app.action('deny_workflow', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value as string;
      const clickingUserId = (body as any).user?.id as string;
      await onDeny(approvalId, clickingUserId, respond);
    });
  }

  async send(channelId: string, threadId: string | undefined, text: string): Promise<SentMessage> {
    const result = await this.app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadId,
      text,
    });
    return { messageId: result.ts as string };
  }

  async sendWorkflowApproval(
    channelId: string,
    threadId: string | undefined,
    approvalId: string,
    prompt: string
  ): Promise<SentMessage> {
    const result = await this.app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadId,
      text: `Approval requested: ${prompt}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Workflow approval requested*\n${prompt}`,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Approval ID: \`${approvalId}\``,
            },
          ],
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve' },
              style: 'primary',
              action_id: 'approve_workflow',
              value: approvalId,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Deny' },
              style: 'danger',
              action_id: 'deny_workflow',
              value: approvalId,
            },
          ],
        },
      ],
    });
    return { messageId: result.ts as string };
  }

  async sendText(channelId: string, threadId: string | undefined, text: string): Promise<{ ts: string }> {
    const result = await this.app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadId,
      text,
    });
    return { ts: result.ts as string };
  }

  async update(channelId: string, messageId: string, text: string): Promise<void> {
    await this.app.client.chat.update({
      channel: channelId,
      ts: messageId,
      text,
    });
  }

  async uploadFile(channelId: string, threadId: string | undefined, file: Buffer, filename: string): Promise<void> {
    const uploadArgs: any = {
      channel_id: channelId,
      file,
      filename,
    };
    if (threadId) {
      uploadArgs.thread_ts = threadId;
    }
    await this.app.client.files.uploadV2(uploadArgs);
  }

  async downloadFile(file: PlatformFile): Promise<Buffer> {
    const ref = file.ref as SlackFileRef;
    return downloadSlackFile(ref.url, ref.token);
  }

  supports(capability: 'reactions'): boolean {
    return capability === 'reactions';
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.app.client.reactions.add({
      channel: channelId,
      timestamp: messageId,
      name: normalizeSlackReactionName(emoji),
    });
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.app.client.reactions.remove({
      channel: channelId,
      timestamp: messageId,
      name: normalizeSlackReactionName(emoji),
    });
  }

  // --- Canvas ---
  // Uses apiCall (untyped) so this builds regardless of @slack/web-api version.
  // When channelId is provided, creates a channel-tabbed canvas (works on free plans);
  // otherwise creates a standalone canvas. Requires canvases:write.
  // grantUserId: give that user write access (so a bot-created canvas is visible/editable to them
  // without exposing it to a whole channel).
  async createCanvas(title: string, markdown: string, channelId?: string, grantUserId?: string): Promise<CreatedCanvas> {
    const documentContent = { type: 'markdown', markdown };
    let canvasId: string;
    if (channelId) {
      const result: any = await this.app.client.apiCall('conversations.canvases.create', {
        channel_id: channelId,
        document_content: documentContent,
      });
      canvasId = (result.canvas_id ?? result.canvas?.id) as string;
    } else {
      const result: any = await this.app.client.apiCall('canvases.create', {
        title,
        document_content: documentContent,
      });
      canvasId = result.canvas_id as string;
    }
    if (grantUserId) await this.grantAccess('canvases.access.set', 'canvas_id', canvasId, grantUserId);
    return { canvasId, permalink: await this.filePermalink(canvasId) };
  }

  // Grant a single user write access to a canvas or list (best-effort). Slack has no ownership
  // transfer; an explicit user grant is the closest equivalent and keeps it private to that user.
  private async grantAccess(method: string, idKey: 'canvas_id' | 'list_id', id: string, userId: string): Promise<void> {
    try {
      await this.app.client.apiCall(method, { [idKey]: id, access_level: 'write', user_ids: [userId] });
    } catch (err) {
      this.logger.warn(`${method} failed`, { error: String(err) });
    }
  }

  // Canvases and lists are file-backed (F-ids), so files.info yields a shareable permalink.
  private async filePermalink(fileId: string): Promise<string | undefined> {
    try {
      const info: any = await this.app.client.files.info({ file: fileId });
      return info?.file?.permalink as string | undefined;
    } catch {
      return undefined;
    }
  }

  // Appends markdown to the end of an existing canvas (iterative-update use case).
  async editCanvas(canvasId: string, markdown: string): Promise<void> {
    await this.app.client.apiCall('canvases.edit', {
      canvas_id: canvasId,
      changes: [
        {
          operation: 'insert_at_end',
          document_content: { type: 'markdown', markdown },
        },
      ],
    });
  }

  // --- Scheduled messages ---
  // post_at is a Unix timestamp (seconds), up to 120 days out. Requires chat:write.
  async scheduleMessage(
    channelId: string,
    threadId: string | undefined,
    text: string,
    postAt: number
  ): Promise<ScheduledMessage> {
    const result = await this.app.client.chat.scheduleMessage({
      channel: channelId,
      thread_ts: threadId,
      text,
      post_at: postAt,
    });
    return {
      scheduledMessageId: result.scheduled_message_id as string,
      postAt: (result.post_at as number) ?? postAt,
    };
  }

  async listScheduledMessages(channelId?: string): Promise<ScheduledMessageSummary[]> {
    const result = await this.app.client.chat.scheduledMessages.list(
      channelId ? { channel: channelId } : {}
    );
    return (result.scheduled_messages ?? []).map((m: any) => ({
      id: m.id as string,
      channelId: m.channel_id as string,
      postAt: m.post_at as number,
      text: m.text as string | undefined,
    }));
  }

  async cancelScheduledMessage(channelId: string, scheduledMessageId: string): Promise<void> {
    await this.app.client.chat.deleteScheduledMessage({
      channel: channelId,
      scheduled_message_id: scheduledMessageId,
    });
  }

  // --- Native reminders ---
  // `time` is a Unix timestamp (seconds), a number of seconds from now, or natural language
  // ("in 30 minutes", "tomorrow at 9am"). With a bot token, `user` targets another user.
  // Requires reminders:write. NOTE: the reminders API is degraded/on a retirement path — prefer
  // scheduleMessage for durable time-based delivery.
  async addReminder(userId: string, text: string, time: string | number): Promise<CreatedReminder> {
    const result: any = await this.app.client.reminders.add({
      text,
      time,
      user: userId,
    } as any);
    return { reminderId: (result.reminder?.id ?? '') as string };
  }

  // --- Lists / tasks ---
  // Uses apiCall (untyped) — slackLists.* typings require @slack/web-api >= 7.8. Requires the
  // lists:write / lists:read scopes and a PAID Slack plan. List text fields are always rich text.
  private static toRichText(text: string): unknown[] {
    return [
      {
        type: 'rich_text',
        elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }],
      },
    ];
  }

  private static primaryColumn(columns: any[]): any {
    return columns.find((c) => c?.is_primary_column) ?? columns.find((c) => c?.type === 'text') ?? columns[0];
  }

  // grantUserId: give that user write access so the bot-created list is visible/editable to them.
  async createTaskList(name: string, grantUserId?: string): Promise<CreatedTaskList> {
    const result: any = await this.app.client.apiCall('slackLists.create', {
      name,
      schema: [{ key: 'task', name: 'Task', type: 'text', is_primary_column: true }],
    });
    const columns: any[] = result.list_metadata?.schema ?? [];
    const listId = result.list_id as string;
    if (grantUserId) await this.grantAccess('slackLists.access.set', 'list_id', listId, grantUserId);
    return {
      listId,
      primaryColumnId: SlackTransport.primaryColumn(columns)?.id,
      permalink: await this.filePermalink(listId),
    };
  }

  private async resolvePrimaryColumnId(listId: string): Promise<string | undefined> {
    const result: any = await this.app.client.apiCall('slackLists.columns.list', { list_id: listId });
    const columns: any[] = result.columns ?? result.list_metadata?.schema ?? result.schema ?? [];
    return SlackTransport.primaryColumn(columns)?.id;
  }

  async addTask(listId: string, text: string, columnId?: string): Promise<CreatedTask> {
    const colId = columnId ?? (await this.resolvePrimaryColumnId(listId));
    if (!colId) throw new Error('Could not resolve a text column for the list');
    const result: any = await this.app.client.apiCall('slackLists.items.create', {
      list_id: listId,
      initial_fields: [{ column_id: colId, rich_text: SlackTransport.toRichText(text) }],
    });
    return { itemId: (result.item?.id ?? result.id ?? '') as string };
  }

  async listTasks(listId: string): Promise<TaskItem[]> {
    const result: any = await this.app.client.apiCall('slackLists.items.list', { list_id: listId });
    const items: any[] = result.items ?? [];
    return items.map((it) => ({ id: (it.id ?? '') as string, text: SlackTransport.extractItemText(it) }));
  }

  // Best-effort: pull plain text out of a list item's first rich_text field.
  private static extractItemText(item: any): string {
    const fields: any[] = item?.fields ?? [];
    for (const f of fields) {
      const blocks = f?.rich_text ?? f?.value?.rich_text;
      const text = SlackTransport.flattenRichText(blocks);
      if (text) return text;
    }
    return item?.title ?? '(untitled)';
  }

  private static flattenRichText(blocks: any): string {
    if (!Array.isArray(blocks)) return '';
    const out: string[] = [];
    for (const block of blocks) {
      for (const section of block?.elements ?? []) {
        for (const el of section?.elements ?? []) {
          if (typeof el?.text === 'string') out.push(el.text);
        }
      }
    }
    return out.join('').trim();
  }

  private convertEvent(event: any): IncomingMessage {
    const files: PlatformFile[] | undefined = event.files?.map((f: any) => ({
      name: f.name,
      mimeType: f.mimetype,
      size: f.size,
      ref: {
        url: f.url_private_download,
        token: this.botToken,
      },
    }));

    return {
      platform: 'slack',
      channelId: event.channel,
      threadId: event.thread_ts,
      messageId: event.ts,
      userId: event.user,
      text: event.text,
      files: files && files.length > 0 ? files : undefined,
      isDM: (event.channel as string).startsWith('D'),
    };
  }

  private async getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      try {
        const response = await this.app.client.auth.test();
        this.botUserId = response.user_id as string;
      } catch (error) {
        this.logger.error('Failed to get bot user ID', error);
        this.botUserId = '';
      }
    }
    return this.botUserId;
  }
}
