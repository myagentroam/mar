import { AgentError } from '../../error.js';
import type { ClientToolDefinition } from '../contracts.js';
import { TOOL_EXECUTION_LIMITS } from '../execution-limits.js';
import type { ToolRuntimeContext } from '../runtime-context.js';
import type { TodoItem } from './todo.js';

/** Owns the model-facing Todo contract; Session state and restoration belong to TodoStore. */
export const todoToolDefinition: ClientToolDefinition = {
  name: 'todo',
  allowedCallers: ['direct', 'programmatic'],
  parallelSafety: 'safe',
  description:
    'Read or replace this session’s Todo list. action=read returns revision and all items; omit items. action=write requires the complete items array (empty clears it), replaces the entire list, and returns revision/count; no prior read or revision precondition is required. Preserve stable IDs and statuses when continuing the same objective; replace old items for a materially different objective. Do not retain completed items from an earlier objective. Use only for coordination-heavy work, not straightforward bounded tasks. Keep at most one in_progress item and update only after meaningful stage changes. When an independent substantive tool call is ready, include it in the same response instead of spending a response only on Todo bookkeeping.',
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
