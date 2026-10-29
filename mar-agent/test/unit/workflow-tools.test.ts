import { describe, expect, it, vi } from 'vitest';
import { restoreTodoStore, TodoStore } from '../../src/tools/agent/todo.js';
import { applyPatchToolDefinition } from '../../src/tools/local/apply-patch.js';
import { execToolDefinition, execWaitToolDefinition } from '../../src/tools/local/exec.js';
import { executeTodoWrite, todoWriteToolDefinition } from '../../src/tools/agent/todo-write.js';
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

  it('presents question as the preferred Plan path for unresolved user-owned decisions', () => {
    expect(questionToolDefinition.description).toContain('Prefer asking over guessing');
    expect(questionToolDefinition.description).toContain('one to three tightly related');
    expect(questionToolDefinition.description).toContain('another question round');
    expect(questionToolDefinition.description).toContain('configuration, branches, abstractions');
    expect(questionToolDefinition.description).toContain(
      'cannot be inferred from the request, conversation, or relevant safe discovery'
    );
    expect(questionToolDefinition.description).toContain('recommended option first');
    expect(JSON.stringify(questionToolDefinition.inputSchema)).toContain(
      'Put the recommended option first'
    );
    expect(questionToolDefinition.description).not.toContain('only when');
  });

  it('documents model-visible execution and recovery behavior', () => {
    expect(execToolDefinition.description).toContain('bounded stdout/stderr');
    expect(execToolDefinition.description).toContain('with processId, not exec');
    expect(execWaitToolDefinition.allowedCallers).toEqual(['direct', 'programmatic']);
    expect(execWaitToolDefinition.codeModeExposure).toBe('both');
    expect(execWaitToolDefinition.description).toContain('Prefer direct calls for a single wait');
    expect(execWaitToolDefinition.description).toContain('use tools.exec_wait for composition');
    expect(execWaitToolDefinition.description).toContain('incremental stdout/stderr');
    expect(execWaitToolDefinition.description).toContain('cannot start a process');
    expect(execToolDefinition.description).toContain('truncated');
    expect(applyPatchToolDefinition.description).toContain(
      'Returns changed file paths and operations'
    );
    expect(applyPatchToolDefinition.description).toContain(
      'Do not batch all task files merely to reduce tool calls'
    );
    expect(applyPatchToolDefinition.description).toContain('successive bounded patches');
    expect(applyPatchToolDefinition.description).toContain('Oversized patches are rejected');
    expect(applyPatchToolDefinition.description).not.toContain('100 files');
    expect(applyPatchToolDefinition.description).not.toContain('4 MiB');
    expect(applyPatchToolDefinition.description).toContain('@@ <change context>');
    expect(applyPatchToolDefinition.description).toContain(
      'hunk match conflicts identify the affected path and hunk'
    );
    expect(applyPatchToolDefinition.description).toContain('MAR_AGENT_PATCH_PARTIAL');
    expect(todoWriteToolDefinition.description).toContain(
      'Do not retain completed items from an earlier objective'
    );
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
    expect(todoWriteToolDefinition.inputSchema.required).toEqual(['items']);
    expect(todoWriteToolDefinition.inputSchema.properties).not.toHaveProperty('expectedRevision');
    const emit = vi.fn(async () => undefined);
    const context = {
      todo: TodoStore.restore({
        revision: 7,
        items: [{ id: 'old', step: 'Old objective', status: 'completed' }]
      }),
      emit
    } as unknown as ToolRuntimeContext;
    const items = [{ id: 'new', step: 'New objective', status: 'in_progress' }];

    const written = await executeTodoWrite({ items }, context);
    expect(JSON.parse(written.content)).toEqual({ revision: 8, count: 1 });
    expect(written.data).toEqual({ revision: 8, items });
    const cleared = await executeTodoWrite({ items: [] }, context);
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

  it('strictly validates Todo tool inputs at runtime', async () => {
    const context = {
      todo: new TodoStore(),
      emit: async () => undefined
    } as never;
    for (const operation of [
      () => executeTodoWrite(undefined, context),
      () => executeTodoWrite({}, context),
      () => executeTodoWrite({ items: 'invalid' }, context),
      () => executeTodoWrite({ items: [], unknown: true }, context),
      () => executeTodoWrite({ items: [], expectedRevision: 0 }, context),
      () =>
        executeTodoWrite({ items: [{ id: '   ', step: 'Do work', status: 'pending' }] }, context)
    ])
      await expect(operation()).rejects.toMatchObject({
        code: 'MAR_AGENT_TOOL_INPUT_INVALID'
      });
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
