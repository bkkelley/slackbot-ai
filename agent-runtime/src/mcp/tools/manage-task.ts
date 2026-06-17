import { callTransportProxy } from './transport-proxy.js';

// Slack Lists-backed task management. Requires lists:write/lists:read scopes and a PAID Slack plan.

export interface CreateTaskListInput {
  name: string;
  platform?: string;
}
export interface CreateTaskListResult {
  ok: boolean;
  listId?: string;
  primaryColumnId?: string;
  error?: string;
}

export async function createTaskList(input: CreateTaskListInput): Promise<CreateTaskListResult> {
  if (!input.name) return { ok: false, error: 'name is required' };
  const result = await callTransportProxy('task', {
    platform: input.platform ?? 'slack',
    op: 'create-list',
    name: input.name,
  });
  return {
    ok: result.ok !== false,
    listId: result.listId as string | undefined,
    primaryColumnId: result.primaryColumnId as string | undefined,
    error: result.error,
  };
}

export interface AddTaskInput {
  listId: string;
  text: string;
  columnId?: string;
  platform?: string;
}
export interface AddTaskResult {
  ok: boolean;
  itemId?: string;
  error?: string;
}

export async function addTask(input: AddTaskInput): Promise<AddTaskResult> {
  if (!input.listId) return { ok: false, error: 'listId is required' };
  if (!input.text) return { ok: false, error: 'text is required' };
  const result = await callTransportProxy('task', {
    platform: input.platform ?? 'slack',
    op: 'add',
    listId: input.listId,
    text: input.text,
    columnId: input.columnId,
  });
  return { ok: result.ok !== false, itemId: result.itemId as string | undefined, error: result.error };
}

export interface ListTasksInput {
  listId: string;
  platform?: string;
}
export interface ListTasksResult {
  ok: boolean;
  items?: Array<{ id: string; text: string }>;
  error?: string;
}

export async function listTasks(input: ListTasksInput): Promise<ListTasksResult> {
  if (!input.listId) return { ok: false, error: 'listId is required' };
  const result = await callTransportProxy('task', {
    platform: input.platform ?? 'slack',
    op: 'list',
    listId: input.listId,
  });
  return { ok: result.ok !== false, items: result.items as ListTasksResult['items'], error: result.error };
}
