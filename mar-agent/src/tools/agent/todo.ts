import { AgentError } from '../../error.js';
import {
  normalizeTodoItems,
  todoItemsFromSnapshot,
  type TodoItem,
  type TodoSnapshot
} from '../../session/todo.js';
export type { TodoItem, TodoSnapshot } from '../../session/todo.js';

export class TodoStore {
  #revision = 0;
  #items: TodoItem[] = [];
  static restore(snapshot: TodoSnapshot): TodoStore {
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0)
      throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Todo revision is invalid.');
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

export function restoreTodoStore(snapshots: readonly unknown[]): TodoStore {
  const todo = new TodoStore();
  for (const snapshot of snapshots) {
    const items = todoItemsFromSnapshot(snapshot);
    if (!items) continue;
    todo.write({ items });
  }
  return todo;
}
