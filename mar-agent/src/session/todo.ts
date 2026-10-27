import { AgentError } from '../error.js';

export interface TodoItem {
  id: string;
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface TodoSnapshot {
  revision: number;
  items: TodoItem[];
}

export function todoItemsFromSnapshot(snapshot: unknown): TodoItem[] | undefined {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot))
    return undefined;
  const items = (snapshot as { items?: unknown }).items;
  if (!Array.isArray(items)) return undefined;
  try {
    return normalizeTodoItems(items as TodoItem[]);
  } catch (error) {
    if (error instanceof AgentError && error.code === 'MAR_AGENT_TOOL_INPUT_INVALID')
      return undefined;
    throw error;
  }
}

export function normalizeTodoItems(items: readonly TodoItem[]): TodoItem[] {
  if (
    items.filter((item) => item?.status === 'in_progress').length > 1 ||
    new Set(items.map((item) => item?.id)).size !== items.length ||
    items.some(
      (item) =>
        item === null ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        typeof item.id !== 'string' ||
        !item.id ||
        typeof item.step !== 'string' ||
        !item.step.trim() ||
        !['pending', 'in_progress', 'completed'].includes(item.status)
    )
  )
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Todo items are invalid.');
  return items.map((item) => ({ ...item, step: item.step.trim() }));
}
