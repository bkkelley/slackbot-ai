# Multi-Channel Bot Architecture Plan

## Goal

Refactor the Slack bot into a multi-channel bot supporting Slack and Discord (and future channels) by separating platform-specific code from shared orchestration logic.

## Decisions

- **Single process**: Both adapters run in the same process, sharing MCP manager, session manager, working directory state, etc.
- **Both modes on all channels**: Full Claude Code interactive sessions AND agent/dispatcher integration (Sage, inbox-processor, etc.)
- **Full refactor**: Restructure Slack bot into the new shape first, then add Discord adapter.

---

## Current coupling (what needs to change)

`slack-handler.ts` mixes three concerns:
1. **Platform wiring** — Slack SDK event subscriptions, `app.client.reactions.add()`, `files.uploadV2()`
2. **Message pipeline** — rate limiting, session management, Claude streaming loop, todo tracking
3. **Formatting** — Slack-flavored markdown, tool-use display strings

`claude-handler.ts` has one Slack leak: the `permission-mcp-server` it injects references `SLACK_BOT_TOKEN` and posts interactive buttons to Slack.

Everything else (`todo-manager`, `working-dir-manager`, `mcp-manager`, `sync-job-handler`) is already clean.

---

## Target directory structure

```
slack-bot/src/
  orchestration/
    types.ts               # ChannelAdapter interface, IncomingMessage, SentMessage, etc.
    message-processor.ts   # the shared pipeline (extracted from slack-handler.ts)
    claude-handler.ts      # Claude streaming — permission server injected, not hardcoded
    session-manager.ts     # session key/CRUD (split out of claude-handler)
    file-processor.ts      # content embedding/prompt formatting (no download)
    todo-manager.ts        # unchanged
    working-dir-manager.ts # unchanged
    mcp-manager.ts         # unchanged
    agent-handler.ts       # unchanged (mostly generic already)
    rate-limiter.ts        # unchanged
    commands/              # cwd, mcp, jobs, model, skills, agents, help — logic only

  channels/
    slack/
      adapter.ts           # @slack/bolt wiring, implements ChannelAdapter
      formatter.ts         # formatMessage(), formatToolUse() — Slack markdown
      file-downloader.ts   # download via SLACK_BOT_TOKEN
      permission-server.ts # interactive button MCP server (moved from src/)

    discord/
      adapter.ts           # discord.js wiring, implements ChannelAdapter
      formatter.ts         # Discord markdown/embeds
      file-downloader.ts   # Discord CDN download

  index.ts                 # bootstraps both adapters into one process
  config.ts                # extended for Discord env vars
  logger.ts                # unchanged
```

---

## Key interface

```typescript
// orchestration/types.ts

interface IncomingMessage {
  platform: 'slack' | 'discord';
  channelId: string;
  threadId?: string;      // thread_ts in Slack, thread snowflake in Discord
  messageId: string;      // ts in Slack, message snowflake in Discord
  userId: string;
  text?: string;
  files?: PlatformFile[];
  isDM: boolean;
}

interface PlatformFile {
  name: string;
  mimeType: string;
  size: number;
  ref: unknown;           // opaque — each adapter knows how to fetch it
}

interface SentMessage {
  messageId: string;
}

interface ChannelAdapter {
  // lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // inbound
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;

  // outbound
  send(channelId: string, threadId: string | undefined, text: string): Promise<SentMessage>;
  update(channelId: string, messageId: string, text: string): Promise<void>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  uploadFile(channelId: string, threadId: string | undefined, filePath: string): Promise<void>;
  downloadFile(file: PlatformFile): Promise<Buffer>;

  // optional — adapter provides platform-specific permission mechanism
  // if null, claude runs bypassPermissions with no interactive approval
  createPermissionProvider?(context: PermissionContext): PermissionProvider | null;

  // formatting — adapters translate generic tool events to platform strings
  formatToolUse(toolName: string, input: unknown): string;
  formatMessage(text: string): string;
}
```

---

## The three tricky seams

**1. Permission flow**
Currently `claude-handler.ts` injects a Slack-specific MCP server that posts interactive buttons.
This becomes an injected `PermissionProvider` that the adapter supplies.
- Slack adapter → interactive button MCP server
- Discord adapter → DM with buttons (or bypass initially)
- No adapter / not configured → auto-bypass

**2. File download**
Each platform has its own auth/URL scheme. The orchestration layer calls `adapter.downloadFile(file.ref)`
and gets back a `Buffer`. File *processing* (content embedding, image temp paths) stays in
`orchestration/file-processor.ts`.

**3. Formatting**
`formatToolUse()` and `formatMessage()` live on the adapter. The pipeline calls them with generic
data; the adapter returns platform-specific strings. Discord uses `**bold**` and code blocks the
same way as Markdown, but Slack uses `*bold*` and has its own mrkdwn quirks.

---

## Phased implementation

### Phase 1 — Extract orchestration layer
*No behavior change to the Slack bot.*

- Create `orchestration/types.ts` with the `ChannelAdapter` interface
- Move `todo-manager`, `working-dir-manager`, `mcp-manager`, `rate-limiter` as-is
- Create `session-manager.ts` extracted from `claude-handler.ts`
- Update `claude-handler.ts` to accept an optional `permissionServerConfig` param instead of hardcoding Slack
- Extract `message-processor.ts` from `slack-handler.ts` — takes a `ChannelAdapter` dependency
- Move commands to `orchestration/commands/`

### Phase 2 — Slack adapter
*Slack still works identically after this phase.*

- Create `channels/slack/adapter.ts` implementing `ChannelAdapter` — wraps `@slack/bolt`
- Move formatting into `channels/slack/formatter.ts`
- Move file download into `channels/slack/file-downloader.ts`
- Move `permission-mcp-server.ts` to `channels/slack/`
- Rewrite `index.ts` to bootstrap via `SlackAdapter → MessageProcessor`

### Phase 3 — Discord adapter

- Create `channels/discord/adapter.ts` using `discord.js`
- Implement `formatter.ts` and `file-downloader.ts` for Discord
- Wire agent-handler's dispatcher integration through the same `MessageProcessor`

### Phase 4 — Unified entry point

- `index.ts` starts both adapters in parallel, sharing one `McpManager`, `SessionManager`, `WorkingDirManager`

---

## Notes / open questions

- Discord permission flow (interactive approval) needs a decision: auto-bypass initially, or implement Discord button equivalent from the start?
- The `sync-job-handler.ts` in the slackbot currently has no subagent support (no `SPAWN_AGENT:` parsing). Same gap exists in the scheduler's `sync-job-runner.js`. Worth addressing alongside this refactor or separately?
- Agent-channel mapping (`AGENT_CHANNELS` in `agent-handler.ts`) is currently driven by env vars. With Discord, this will need to support mapping Discord channel IDs to agents too.
