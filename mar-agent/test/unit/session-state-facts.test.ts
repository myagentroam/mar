import { describe, expect, it } from 'vitest';
import { cloneCoreJson } from '../../src/session/extension-checkpoint.js';
import { normalizeTodoItems, todoItemsFromSnapshot } from '../../src/session/todo.js';
import {
  CODE_STATE_LIMITS,
  applyCodeModeStateMutations,
  parseCodeModeStateMutations,
  restoreCodeModeState
} from '../../src/session/code-state.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/tools/execution-limits.js';

describe('Session state facts', () => {
  it('copies JSON without prototype setters and rejects cyclic checkpoint values', () => {
    const source = JSON.parse('{"__proto__":{"safe":true},"values":[1,false,null]}');
    const copied = cloneCoreJson(source);
    expect(copied).toEqual(source);
    expect(copied).not.toBe(source);
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => cloneCoreJson(cyclic)).toThrowError(
      expect.objectContaining({ code: 'MAR_AGENT_EXTENSION_DATA_INVALID' })
    );
  });

  it('normalizes todo facts and rejects malformed or conflicting snapshots', () => {
    const input = [{ id: 'one', step: '  Do work  ', status: 'in_progress' as const }];
    expect(todoItemsFromSnapshot({ revision: 1, items: input })).toEqual([
      { id: 'one', step: 'Do work', status: 'in_progress' }
    ]);
    expect(input[0]?.step).toBe('  Do work  ');
    expect(
      todoItemsFromSnapshot({ items: [...input, { ...input[0], id: 'two' }] })
    ).toBeUndefined();
    expect(() => normalizeTodoItems([...input, ...input])).toThrowError(
      expect.objectContaining({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' })
    );
  });

  it('validates and applies code-state mutations, and reports malformed history as corrupt', () => {
    const mutations = parseCodeModeStateMutations([
      { operation: 'set', key: 'key', value: { nested: [1, 2] } }
    ]);
    const expected = [{ key: 'key', value: { nested: [1, 2] } }];
    expect(applyCodeModeStateMutations([], mutations)).toEqual(expected);
    expect(restoreCodeModeState([{ type: 'code.state.updated', payload: { mutations } }])).toEqual(
      expected
    );
    expect(() =>
      restoreCodeModeState([{ type: 'code.state.updated', payload: { mutations: null } }])
    ).toThrowError(expect.objectContaining({ code: 'MAR_AGENT_SESSION_CORRUPT' }));
    expect(() =>
      parseCodeModeStateMutations([{ operation: 'set', key: '', value: true }])
    ).toThrowError(expect.objectContaining({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' }));
  });

  it('shares the persisted state limits with the tool and rejects a key beyond the byte limit', () => {
    expect(TOOL_EXECUTION_LIMITS).toMatchObject(CODE_STATE_LIMITS);
    const key = 'x'.repeat(CODE_STATE_LIMITS.codeStateMaxKeyBytes);
    expect(parseCodeModeStateMutations([{ operation: 'delete', key }])).toEqual([
      { operation: 'delete', key }
    ]);
    expect(() =>
      parseCodeModeStateMutations([{ operation: 'delete', key: `${key}x` }])
    ).toThrowError(expect.objectContaining({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' }));
  });
});
