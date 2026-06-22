# Claude Code Slack Bot

This is a TypeScript-based Slack bot that integrates with the Claude Code SDK to provide AI-powered coding assistance directly within Slack workspaces.

## Project Overview

The bot allows users to interact with Claude Code through Slack, providing real-time coding assistance, file analysis, code reviews, and project management capabilities. It supports both direct messages and channel conversations, with channel-to-project mapping and task tracking.

## Architecture

### Core Components

- **`src/index.ts`** - Application entry point and initialization
- **`src/config.ts`** - Environment configuration and validation
- **`src/slack-handler.ts`** - Main Slack event handling and message processing
- **`src/claude-handler.ts`** - Claude Code SDK integration and session management
- **`src/working-directory-manager.ts`** - Working directory configuration and resolution
- **`src/file-handler.ts`** - File upload processing and content embedding
- **`src/todo-manager.ts`** - Task list management and progress tracking
- **`src/mcp-manager.ts`** - MCP server configuration and management
- **`src/logger.ts`** - Structured logging utility
- **`src/types.ts`** - TypeScript type definitions

### Key Features

#### 1. Channel → Project Mapping
- **Explicit mapping**: `project map <name>` (channel) or the App Home modal maps a channel to a project = a workspace directory. Claude runs there when mentioned, with a context preamble.
- **Default workspace**: unmapped channels and DMs use `~/claude-workspaces/general/`.
- **DM scoping**: a leading `project: <name>` line scopes a DM thread.
- **Storage**: `~/claude-workspaces/channel-projects.json` (see `orchestration/channel-projects.ts`). There is no `cwd` command — this replaced the old working-directory system.

#### 2. Real-Time Task Tracking
- **Todo Lists**: Displays Claude's planning process as formatted task lists in Slack
- **Progress Updates**: Updates task status in real-time as Claude works
- **Priority Indicators**: Visual priority levels (🔴 High, 🟡 Medium, 🟢 Low)
- **Status Reactions**: Emoji reactions on original messages show overall progress
- **Live Updates**: Single message updates instead of spam

#### 3. File Upload Support
- **Multiple Formats**: Images (JPG, PNG, GIF, WebP), text files, code files, documents
- **Content Embedding**: Text files are embedded directly in prompts
- **Image Analysis**: Images are saved for Claude to analyze using the Read tool
- **Size Limits**: 50MB file size limit with automatic cleanup
- **Security**: Secure download using Slack bot token authentication

#### 4. Advanced Message Handling
- **Streaming Responses**: Real-time message updates as Claude generates responses
- **Tool Formatting**: Rich formatting for file edits, bash commands, and other tool usage
- **Status Indicators**: Clear visual feedback (🤔 Thinking, ⚙️ Working, ✅ Completed)
- **Error Handling**: Graceful error recovery with informative messages
- **Session Management**: Conversation context maintained across interactions

#### 5. Channel Integration
- **Auto-Setup**: Automatic welcome message when added to channels
- **Mentions**: Responds to @mentions in channels
- **Thread Support**: Maintains context within threaded conversations
- **File Uploads**: Handles file uploads in any conversation context
- **Auto-Workspace**: When a Slack channel is created, automatically creates a matching folder under `~/claude-workspaces/<channel-name>/` via the management API (`POST /agents/api/projects`). Uses Socket Mode — no public URL required.

#### 6. MCP (Model Context Protocol) Integration
- **External Tools**: Extends Claude's capabilities with external MCP servers
- **Multiple Server Types**: Supports stdio, SSE, and HTTP MCP servers
- **Auto-Configuration**: Loads servers from `mcp-servers.json` automatically
- **Tool Management**: All MCP tools are allowed by default with `mcp__serverName__toolName` pattern
- **Runtime Management**: Reload configuration without restarting the bot
- **Popular Integrations**: Filesystem access, GitHub API, database connections, web search

## Environment Configuration

### Required Variables
```env
# Slack App Configuration
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token  
SLACK_SIGNING_SECRET=your-signing-secret

# Claude Code Configuration
ANTHROPIC_API_KEY=your-anthropic-api-key
```

### Optional Variables
```env
# Working Directory Configuration
BASE_DIRECTORY=/Users/username/Code/

# Third-party API Providers
CLAUDE_CODE_USE_BEDROCK=1
CLAUDE_CODE_USE_VERTEX=1

# Development
DEBUG=true
```

## Slack App Configuration

### Required Permissions
- `app_mentions:read` - Read mentions
- `channels:history` - Read channel messages
- `chat:write` - Send messages
- `chat:write.public` - Write to public channels
- `im:history` - Read direct messages
- `im:read` - Basic DM info
- `im:write` - Send direct messages
- `users:read` - Read user information
- `reactions:read` - Read message reactions
- `reactions:write` - Add/remove reactions
- `canvases:write` - Create/edit canvases (WriteCanvas tool)
- `canvases:read` - Read canvases
- `reminders:write` - Create native Slack reminders (AddReminder tool; degraded API — prefer ScheduleMessage)
- `lists:write` - Create lists/items (tasks, CreateTaskList/AddTask tools; **requires a paid Slack plan**)
- `lists:read` - Read list items (ListTasks tool)
- _(scheduled messages use the existing `chat:write` scope — no new scope needed)_

### Required Events
- `app_mention` - When the bot is mentioned
- `message.im` - Direct messages
- `member_joined_channel` - When bot is added to channels
- `channel_created` - Auto-creates a matching workspace folder under `~/claude-workspaces/`
- `app_home_opened` - Renders the App Home tab (also enable the **Home Tab** under App Home in app settings)

### Socket Mode
The bot uses Socket Mode for real-time event handling, requiring an app-level token with `connections:write` scope.

## Usage Patterns

### Channel Setup
```
1. Add bot to channel
2. (optional) Map it to a project: `project map acme-api`
3. Mention the bot: `@ClaudeBot help me with authentication`
   → unmapped channels run in the `general` workspace
```

### DM thread scoping
```
project: acme-api
now help me with this other codebase
```

### File Analysis
```
[Upload image/code file]
Analyze this screenshot and suggest improvements
```

### Task Tracking
Users see real-time task lists as Claude plans and executes work:
```
📋 Task List

🔄 In Progress:
🔴 Analyze authentication system

⏳ Pending:  
🟡 Implement OAuth flow
🟢 Add error handling

Progress: 1/3 tasks completed (33%)
```

### MCP Server Management
```
# View configured MCP servers
User: mcp
Bot: 🔧 MCP Servers Configured:
     • filesystem (stdio)
     • github (stdio)  
     • postgres (stdio)

# Reload MCP configuration
User: mcp reload
Bot: ✅ MCP configuration reloaded successfully.

# Use MCP tools automatically
User: @ClaudeBot list all TODO comments in the project
Bot: [Uses mcp__filesystem tools to search files]
```

## Development

### Build and Run
```bash
npm install
npm run build
npm run dev     # Development with hot reload
npm run prod    # Production mode
```

### Project Structure
```
src/
├── index.ts                      # Entry point
├── config.ts                     # Configuration
├── slack-handler.ts              # Slack event handling
├── claude-handler.ts             # Claude Code SDK integration
├── working-directory-manager.ts  # Directory management
├── file-handler.ts               # File processing
├── todo-manager.ts               # Task tracking
├── mcp-manager.ts                # MCP server management
├── logger.ts                     # Logging utility
└── types.ts                      # Type definitions

# Configuration files
mcp-servers.json                  # MCP server configuration
mcp-servers.example.json          # Example MCP configuration
```

### Key Design Decisions

1. **Append-Only Messages**: Instead of editing a single message, each response is a separate message for better conversation flow
2. **Session-Based Context**: Each conversation maintains its own Claude Code session for continuity
3. **Smart File Handling**: Text content embedded in prompts, images passed as file paths for Claude to read
4. **Hierarchical Working Directories**: Channel defaults with thread overrides for flexibility
5. **Real-Time Feedback**: Status reactions and live task updates for transparency

### Error Handling
- Graceful degradation when Slack API calls fail
- Automatic retry for transient errors
- Comprehensive logging for debugging
- User-friendly error messages
- Automatic cleanup of temporary files

### Security Considerations
- Environment variables for sensitive configuration
- Secure file download with proper authentication
- Temporary file cleanup after processing
- No storage of user data beyond session duration
- Validation of file types and sizes

## Future Enhancements

Potential areas for expansion:
- Persistent working directory storage (database)
- Advanced file format support (PDFs, Office docs)
- Integration with version control systems
- Custom slash commands
- Team-specific bot configurations
- Analytics and usage tracking