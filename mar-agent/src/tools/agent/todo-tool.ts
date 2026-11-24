import { AgentError } from '../../error.js';
import type { ClientToolDefinition } from '../contracts.js';
import { TOOL_EXECUTION_LIMITS } from '../execution-limits.js';
import type { ToolRuntimeContext } from '../runtime-context.js';
import type { TodoItem } from './todo.js';

/** Owns the model-facing Todo contract; Session state and restoration belong to TodoStore. */
export const todoToolDefinition: ClientToolDefinition = {
  name: 'todo',
  autoPermission: 'omit',
  allowedCallers: ['direct', 'programmatic'],
  parallelSafety: 'safe',
  description:
    'Read or replace the session’s Todo list for coordination-heavy work. action=read returns revision and all items; omit items. action=write replaces the entire list with the supplied items array (empty clears it) and returns a text receipt with revision and count. In Code Mode, both actions return revision and items in data. No prior read or revision precondition is required. The list may contain at most one in_progress item.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'write'] },
      items: {
        type: 'array',
        description: 'Required for write; omit for read. The complete replacement list.',
        maxItems: TOOL_EXECUTION_LIMITS.todoMaxItems,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 128 },
            step: {
              type: 'string',
              minLength: 1,
              maxLength: TOOL_EXECUTION_LIMITS.todoMaxTextCharacters
            },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
          },
          required: ['id', 'step', 'status'],
          additionalProperties: false
        }
      }
    },
    required: ['action'],
    additionalProperties: false
  }
};

export async function executeTodo(arguments_: unknown, context: ToolRuntimeContext) {
  const input = parseTodoInput(arguments_);
  if (input.action === 'read') {
    const todo = context.todo.read();
    return { content: JSON.stringify(todo), data: todo };
  }
  const todo = context.todo.write(input);
  await context.emit({ type: 'todo.updated', revision: todo.revision, items: todo.items });
  return {
    content: JSON.stringify({ revision: todo.revision, count: todo.items.length }),
    data: todo
  };
}

function parseTodoInput(
  value: unknown
): { action: 'read' } | { action: 'write'; items: TodoItem[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['action', 'items'].includes(key))) return invalid();
  if (input.action === 'read') {
    if (input.items != null) return invalid();
    return { action: 'read' };
  }
  if (
    input.action !== 'write' ||
    !Array.isArray(input.items) ||
    input.items.length > TOOL_EXECUTION_LIMITS.todoMaxItems
  )
    return invalid();
  const items = input.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return invalid();
    const record = item as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => !['id', 'step', 'status'].includes(key)) ||
      typeof record.id !== 'string' ||
      record.id.trim().length === 0 ||
      record.id.length > 128 ||
      typeof record.step !== 'string' ||
      record.step.trim().length === 0 ||
      record.step.length > TOOL_EXECUTION_LIMITS.todoMaxTextCharacters ||
      !['pending', 'in_progress', 'completed'].includes(String(record.status))
    )
      return invalid();
    return { id: record.id, step: record.step, status: record.status } as TodoItem;
  });
  return { action: 'write', items };
}

function invalid(): never {
  throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Todo input is invalid.');
}
