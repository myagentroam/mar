import type { ClientToolDefinition } from '../contracts.js';

import type { ToolRuntimeContext } from '../runtime-context.js';
import type { TodoItem } from './todo.js';
import { AgentError } from '../../error.js';
import { TOOL_EXECUTION_LIMITS } from '../execution-limits.js';

export const todoWriteToolDefinition: ClientToolDefinition = {
  name: 'todo_write',
  allowedCallers: ['direct', 'programmatic'],
  parallelSafety: 'serial',
  description:
    'Replace this session’s entire Todo list with the supplied items; no prior read is required. Preserve stable IDs and statuses only when extending the same objective. For a materially different objective, include only the new objective’s items. Do not retain completed items from an earlier objective; when all current items are completed, default a substantive new request to replacement unless the user explicitly asks to continue, extend, verify, or follow up. Use only after Todo has been chosen for coordination-heavy work; straightforward bounded work does not need it. Keep at most one in_progress item and update statuses after meaningful stage changes. When another substantive tool call is already ready and does not depend on the Todo result, include both in the same model response instead of spending a response only for Todo bookkeeping.',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        maxItems: TOOL_EXECUTION_LIMITS.todoMaxItems,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            step: { type: 'string', maxLength: TOOL_EXECUTION_LIMITS.todoMaxTextCharacters },
            status: { enum: ['pending', 'in_progress', 'completed'] }
          },
          required: ['id', 'step', 'status'],
          additionalProperties: false
        }
      }
    },
    required: ['items'],
    additionalProperties: false
  }
};

export async function executeTodoWrite(arguments_: unknown, context: ToolRuntimeContext) {
  const value = parseTodoWriteInput(arguments_);
  const todo = context.todo.write(value);
  await context.emit({ type: 'todo.updated', revision: todo.revision, items: todo.items });
  return {
    content: JSON.stringify({ revision: todo.revision, count: todo.items.length }),
    data: todo
  };
}

function parseTodoWriteInput(value: unknown): { items: TodoItem[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => key !== 'items') ||
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
  return { items };
}

function invalid(): never {
  throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Todo input is invalid.');
}
