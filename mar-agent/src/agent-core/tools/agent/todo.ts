import { MarAgentError } from '../../error.js';
import type { TodoItem, TodoSnapshot } from '../contracts.js';
export type { TodoItem, TodoSnapshot } from '../contracts.js';

export class TodoStore {
  #revision = 0;
  #items: TodoItem[] = [];
  static restore(snapshot: TodoSnapshot): TodoStore {
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0)
      throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Todo revision is invalid.');
    const todo = new TodoStore();
    todo.#revision = snapshot.revision;
    todo.#items = normalizeTodoItems(snapshot.items);
    return todo;
  }
  read() {
    return { revision: this.#revision, items: this.#items.map((item) => ({ ...item })) };
  }
  write(input: { items: readonly TodoItem[] }) {
    this.#items = normalizeTodoItems(input.items);
    this.#revision++;
    return this.read();
  }
}

export function todoItemsFromSnapshot(snapshot: unknown): TodoItem[] | undefined {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot))
    return undefined;
  const items = (snapshot as { items?: unknown }).items;
  if (!Array.isArray(items)) return undefined;
  try {
    return normalizeTodoItems(items as TodoItem[]);
  } catch (error) {
    if (error instanceof MarAgentError && error.code === 'MAR_AGENT_TOOL_INPUT_INVALID')
      return undefined;
    throw error;
  }
}

export function restoreTodoStore(snapshots: readonly unknown[]): TodoStore {
  const todo = new TodoStore();
  for (const snapshot of snapshots) {
    const items = todoItemsFromSnapshot(snapshot);
    if (!items) continue;
    todo.write({ items });
  }
  return todo;
}

function normalizeTodoItems(items: readonly TodoItem[]): TodoItem[] {
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
    throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Todo items are invalid.');
  return items.map((item) => ({ ...item, step: item.step.trim() }));
}
