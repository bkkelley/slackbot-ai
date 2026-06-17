import { ToolEvent } from './types';

export function normalizeToolUse(toolName: string, input: unknown): ToolEvent {
  const inp = input as Record<string, unknown>;

  switch (toolName) {
    case 'Edit': {
      const filePath = (inp.file_path as string) ?? '';
      const oldStr = (inp.old_string as string) ?? '';
      const newStr = (inp.new_string as string) ?? '';
      return { kind: 'edit', path: filePath, summary: `${oldStr.slice(0, 80)} → ${newStr.slice(0, 80)}` };
    }

    case 'MultiEdit': {
      const filePath = (inp.file_path as string) ?? '';
      const edits = (inp.edits as Array<{ old_string: string; new_string: string }>) ?? [];
      return { kind: 'edit', path: filePath, summary: `${edits.length} edit(s)` };
    }

    case 'Write': {
      const filePath = (inp.file_path as string) ?? '';
      const content = (inp.content as string) ?? '';
      return { kind: 'write', path: filePath, bytes: content.length };
    }

    case 'Read': {
      const filePath = (inp.file_path as string) ?? '';
      const startLine = inp.start_line as number | undefined;
      const endLine = inp.end_line as number | undefined;
      const range: [number, number] | undefined =
        startLine !== undefined && endLine !== undefined ? [startLine, endLine] : undefined;
      return { kind: 'read', path: filePath, range };
    }

    case 'Bash': {
      const command = (inp.command as string) ?? '';
      const cwd = inp.cwd as string | undefined;
      return { kind: 'bash', command, cwd };
    }

    case 'Glob': {
      const pattern = (inp.pattern as string) ?? '';
      const cwd = inp.cwd as string | undefined;
      return { kind: 'glob', pattern, cwd };
    }

    case 'Grep': {
      const pattern = (inp.pattern as string) ?? '';
      const filePath = inp.path as string | undefined;
      return { kind: 'grep', pattern, path: filePath };
    }

    case 'TodoWrite': {
      const todos = (inp.todos as Array<{ status: string; content?: string }>) ?? [];
      const added = todos.filter(t => t.status === 'pending').length;
      const inProgress = todos.filter(t => t.status === 'in_progress').length;
      const completed = todos.filter(t => t.status === 'completed').length;
      const action = completed > 0 ? 'complete' : inProgress > 0 ? 'update' : 'add';
      return { kind: 'todo', action, summary: `${todos.length} task(s): ${added} pending, ${inProgress} in_progress, ${completed} completed` };
    }

    case 'WebSearch': {
      const query = (inp.query as string) ?? '';
      return { kind: 'web_search', query };
    }

    case 'WebFetch': {
      const url = (inp.url as string) ?? '';
      return { kind: 'web_fetch', url };
    }

    default: {
      // Handle MCP tools: mcp__serverName__toolName
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__');
        const server = parts[1] ?? '';
        const tool = parts.slice(2).join('__');
        const summary = JSON.stringify(inp).slice(0, 120);
        return { kind: 'mcp', server, tool, summary };
      }

      return { kind: 'unknown', rawName: toolName, summary: toolName };
    }
  }
}
