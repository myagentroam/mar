import { describe, expect, it, vi } from 'vitest';
import { restoreTodoStore, TodoStore } from '../../src/tools/agent/todo.js';
import { applyPatchToolDefinition } from '../../src/tools/local/apply-patch.js';
import { execToolDefinition, execWaitToolDefinition } from '../../src/tools/local/exec.js';
import { executeTodo, todoToolDefinition } from '../../src/tools/agent/todo-tool.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/tools/execution-limits.js';
import { executeQuestion, questionToolDefinition } from '../../src/tools/agent/question.js';
import { AGENT_TOOL_HANDLERS, BUILTIN_TOOL_DEFINITIONS } from '../../src/tools/registry.js';
import type { ToolRuntimeContext } from '../../src/tools/runtime-context.js';

describe('workflow tools', () => {
  it('keeps child-session tools outside the Core tool registry', () => {
    const names = BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith('agent_'))).toEqual([]);
    for (const name of [
      'agent_start',
      'agent_wait',
      'agent_send',
      'agent_stop',
      'agent_list',
      'agent_view'
    ]) {
      expect(names).not.toContain(name);
      expect(AGENT_TOOL_HANDLERS.has(name)).toBe(false);
    }
  });

  it('documents the user-decision boundary and option presentation contract', () => {
    const { description, inputSchema } = questionToolDefinition;
    expect(description).toContain('user-owned decisions that materially change the result');
    expect(description).toContain(
      'cannot be inferred from the request, conversation, or relevant safe discovery'
    );
    expect(description).toContain('not a permission or approval tool');
    expect(inputSchema).toMatchObject({
      properties: {
        questions: {
          minItems: 1,
          maxItems: 3,
          items: {
            properties: {
              options: {
                minItems: 2,
                maxItems: 3,
                description: expect.stringMatching(
                  /recommended option first and identify it in its label or description/u
                )
              }
            }
          }
        }
      }
    });
  });

  it('documents model-visible execution and recovery behavior', () => {
    expect(execToolDefinition.description).toContain('bounded stdout/stderr');
    expect(execToolDefinition.description).toContain('with processId, not exec');
    expect(execWaitToolDefinition.allowedCallers).toEqual(['direct', 'programmatic']);
    expect(execWaitToolDefinition.codeModeExposure).toBe('both');
    expect(execWaitToolDefinition.description).toContain(
      'Cancelling a wait does not terminate the process'
    );
    expect(execWaitToolDefinition.description).toContain('incremental stdout/stderr');
    expect(execWaitToolDefinition.description).toContain('cannot start a process');
    expect(execToolDefinition.description).toContain('truncated');
    const patchDescription = applyPatchToolDefinition.description;
    expect(patchDescription).toContain('Split long or hard-to-review patches');
    expect(patchDescription).toContain('Oversized patches are rejected');
    expect(patchDescription).not.toContain('100 files');
    expect(patchDescription).not.toContain('4 MiB');
    expect(patchDescription).not.toMatch(/freeform|JSON input example|Promise/u);
    for (const syntax of [
      '*** Add File: <path>',
      '*** Update File: <path>',
      '*** Delete File: <path>',
      '*** Move to: <new path>',
      '@@ <change context>'
    ])
      expect(patchDescription).toContain(syntax);
    expect(patchDescription).toContain('Hunk conflicts identify the path and hunk');
    expect(applyPatchToolDefinition.description).toContain('MAR_AGENT_PATCH_PARTIAL');
  });

  it('replaces Todo without a revision precondition and enforces one in-progress item', () => {
    const store = new TodoStore();
    expect(
      store.write({
        items: [
          { id: 'a', step: 'First', status: 'in_progress' },
          { id: 'b', step: 'Second', status: 'pending' }
        ]
      }).revision
    ).toBe(1);
    expect(() =>
      store.write({
        items: [
          { id: 'a', step: 'First', status: 'in_progress' },
          { id: 'b', step: 'Second', status: 'in_progress' }
        ]
      })
    ).toThrow();
    expect(store.write({ items: [] })).toEqual({ revision: 2, items: [] });
  });

  it('writes restored Todo directly and publishes each replacement snapshot', async () => {
    expect(todoToolDefinition.inputSchema.required).toEqual(['action']);
    expect(todoToolDefinition.inputSchema.properties).not.toHaveProperty('expectedRevision');
    const emit = vi.fn(async () => undefined);
    const context = {
      todo: TodoStore.restore({
        revision: 7,
        items: [{ id: 'old', step: 'Old objective', status: 'completed' }]
      }),
      emit
    } as unknown as ToolRuntimeContext;
    const items = [{ id: 'new', step: 'New objective', status: 'in_progress' }];

    const read = await executeTodo({ action: 'read' }, context);
    expect(read.data).toEqual(context.todo.read());
    expect(JSON.parse(read.content)).toEqual(read.data);
    expect(await executeTodo({ action: 'read', items: null }, context)).toEqual(read);
    expect(emit).not.toHaveBeenCalled();
    const written = await executeTodo({ action: 'write', items }, context);
    expect(JSON.parse(written.content)).toEqual({ revision: 8, count: 1 });
    expect(written.data).toEqual({ revision: 8, items });
    const cleared = await executeTodo({ action: 'write', items: [] }, context);
    expect(JSON.parse(cleared.content)).toEqual({ revision: 9, count: 0 });
    expect(cleared.data).toEqual({ revision: 9, items: [] });
    expect(emit.mock.calls).toEqual([
      [{ type: 'todo.updated', revision: 8, items }],
      [{ type: 'todo.updated', revision: 9, items: [] }]
    ]);
  });

  it('restores the latest valid Session Todo and rebuilds revision from snapshot order', () => {
    const restored = restoreTodoStore([
      {
        revision: 1,
        items: [{ id: 'inspect', step: 'Inspect', status: 'in_progress' }]
      },
      { revision: 2, items: [{ id: '', step: 'Invalid', status: 'pending' }] },
      {
        revision: 1,
        items: [
          { id: 'inspect', step: 'Inspect', status: 'completed' },
          { id: 'fix', step: 'Fix', status: 'in_progress' }
        ]
      }
    ]);

    expect(restored.read()).toEqual({
      revision: 2,
      items: [
        { id: 'inspect', step: 'Inspect', status: 'completed' },
        { id: 'fix', step: 'Fix', status: 'in_progress' }
      ]
    });
  });

  it('validates Todo handler inputs before any mutation', async () => {
    const emit = vi.fn(async () => undefined);
    const context = {
      todo: new TodoStore(),
      emit
    } as unknown as ToolRuntimeContext;
    const item = { id: 'a', step: 'Do work', status: 'pending' };
    for (const input of [
      undefined,
      null,
      [],
      {},
      { items: [] },
      { action: 'invalid' },
      { action: 'read', items: [] },
      { action: 'read', unexpected: true },
      { action: 'write' },
      { action: 'write', items: null },
      { action: 'write', items: 'invalid' },
      { action: 'write', items: [], unknown: true },
      { action: 'write', items: [], expectedRevision: 0 },
      { action: 'write', items: [{ ...item, id: '   ' }] },
      { action: 'write', items: [{ ...item, id: 'a'.repeat(129) }] },
      { action: 'write', items: [{ ...item, step: '   ' }] },
      {
        action: 'write',
        items: [{ ...item, step: 'x'.repeat(TOOL_EXECUTION_LIMITS.todoMaxTextCharacters + 1) }]
      },
      { action: 'write', items: [{ ...item, status: 'cancelled' }] },
      { action: 'write', items: [{ ...item, unexpected: true }] },
      { action: 'write', items: [item, item] },
      {
        action: 'write',
        items: [
          { ...item, status: 'in_progress' },
          { ...item, id: 'b', status: 'in_progress' }
        ]
      },
      {
        action: 'write',
        items: Array.from({ length: TOOL_EXECUTION_LIMITS.todoMaxItems + 1 }, (_, index) => ({
          ...item,
          id: String(index)
        }))
      }
    ]) {
      await expect(executeTodo(input, context)).rejects.toMatchObject({
        code: 'MAR_AGENT_TOOL_INPUT_INVALID'
      });
      expect(context.todo.read()).toEqual({ revision: 0, items: [] });
      expect(emit).not.toHaveBeenCalled();
    }
  });

  it('rejects question options that are not structured choices', async () => {
    const context = {
      host: { requestUserInput: async () => ({ choice: 'A' }) },
      signal: new AbortController().signal,
      emit: async () => undefined
    } as never;
    await expect(
      executeQuestion(
        {
          questions: [{ id: 'choice', header: 'Choice', question: 'Choose', options: ['A'] }]
        },
        context
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
  });

  it('rejects blank nested question fields and non-string answers', async () => {
    const baseQuestion = {
      id: 'choice',
      header: 'Choice',
      question: 'Choose a mode.',
      options: [
        { label: 'A', description: 'Use A.' },
        { label: 'B', description: 'Use B.' }
      ]
    };
    const inputContext = {
      host: { requestUserInput: async () => ({ choice: undefined }) },
      signal: new AbortController().signal,
      emit: async () => undefined
    } as never;

    for (const question of [
      { ...baseQuestion, id: '   ' },
      { ...baseQuestion, header: '   ' },
      { ...baseQuestion, question: '\n\t' },
      {
        ...baseQuestion,
        options: [{ label: '   ', description: 'Use A.' }, baseQuestion.options[1]]
      },
      {
        ...baseQuestion,
        options: [{ label: 'A', description: '   ' }, baseQuestion.options[1]]
      }
    ])
      await expect(executeQuestion({ questions: [question] }, inputContext)).rejects.toMatchObject({
        code: 'MAR_AGENT_TOOL_INPUT_INVALID'
      });

    await expect(
      executeQuestion({ questions: [baseQuestion] }, inputContext)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_USER_INPUT_INVALID' });
  });

  it('rejects question answers that do not match every requested id', async () => {
    const context = {
      host: { requestUserInput: async () => ({ unknown: 'A' }) },
      signal: new AbortController().signal,
      emit: async () => undefined
    } as never;
    await expect(
      executeQuestion(
        {
          questions: [
            {
              id: 'choice',
              header: 'Choice',
              question: 'Choose a mode.',
              options: [
                { label: 'A', description: 'Use A.' },
                { label: 'B', description: 'Use B.' }
              ]
            }
          ]
        },
        context
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_USER_INPUT_INVALID' });
  });
});
