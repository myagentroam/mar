import type { ClientToolDefinition } from '../../model/contracts.js';
import type { ToolRuntimeContext } from '../runtime-context.js';

export const todoReadToolDefinition: ClientToolDefinition = {
  name: 'todo_read',
  allowedCallers: ['direct', 'programmatic'],
  parallelSafety: 'safe',
  description:
    'Read this session’s current Todo revision and items when you need the existing list. A prior read is not required to write Todo. Do not read an empty or new Todo merely to decide whether straightforward bounded work needs one.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }
};

export function executeTodoRead(context: ToolRuntimeContext) {
  const plan = context.todo.read();
  return Promise.resolve({ content: JSON.stringify(plan), data: plan });
}
