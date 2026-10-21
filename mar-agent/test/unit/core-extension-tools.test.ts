import { describe, expect, it } from 'vitest';
import {
  ExtensionTools,
  type CoreToolBinding,
  type CoreToolSpec
} from '../../src/agent-core/extensions/tools.js';
import { ExtensionResourceScope } from '../../src/agent-core/extensions/resources.js';
const context = () => ({
  operationId: 'op',
  sessionId: 's',
  sessionEpoch: 0,
  actor: 'sdk' as const,
  entry: 'native-api' as const,
  signal: new AbortController().signal
});
const spec = (value: number): CoreToolSpec => ({
  name: 'value',
  description: 'value',
  inputSchema: { type: 'object' },
  execute: () => ({ content: String(value), data: value })
});
const call = { name: 'value', arguments: {} };

describe('Extension tool source registry', () => {
  it('validates inputs and structured output without applying schema defaults', async () => {
    const tools = new ExtensionTools();
    const scope = new ExtensionResourceScope();
    let calls = 0;
    tools.register(scope, 'validated', {
      ...spec(1),
      inputSchema: {
        type: 'object',
        properties: { amount: { type: 'number', default: 5 } },
        required: ['amount'],
        additionalProperties: false
      },
      outputSchema: { type: 'number' },
      execute: () => {
        calls++;
        return { content: 'result', data: 1 };
      }
    });
    scope.activate();
    const binding = tools.capture().get('value')!;
    await expect(binding.invoke(call, context())).rejects.toThrow(/INPUT_INVALID/);
    await expect(
      binding.invoke({ ...call, arguments: { amount: 'invalid' } }, context())
    ).rejects.toThrow(/INPUT_INVALID/);
    expect(calls).toBe(0);
    expect(await binding.invoke({ ...call, arguments: { amount: 2 } }, context())).toEqual({
      content: 'result',
      data: 1
    });
    expect(calls).toBe(1);
    tools.register(scope, 'validated', {
      ...spec(0),
      outputSchema: { type: 'number' },
      execute: () => ({ content: 'invalid', data: 'wrong' })
    });
    await expect(tools.capture().get('value')!.invoke(call, context())).rejects.toThrow(
      /OUTPUT_INVALID/
    );
    await scope.dispose();
  });

  it('reports unsupported schema conversion and accepts an explicit native validator', async () => {
    const tools = new ExtensionTools();
    const scope = new ExtensionResourceScope();
    const inputSchema = {
      type: 'object',
      if: { required: ['value'] },
      then: { required: ['kind'] }
    };
    expect(() => tools.register(scope, 'native', { ...spec(1), inputSchema })).toThrow(
      /SCHEMA_UNSUPPORTED/
    );
    tools.register(scope, 'native', { ...spec(1), inputSchema, parseInput: (input) => input });
    scope.activate();
    expect((await tools.capture().get('value')!.invoke(call, context())).content).toBe('1');
    await scope.dispose();
  });

  it('freezes nested metadata, hides mutation methods, and restores a revoked same-owner replacement', async () => {
    const tools = new ExtensionTools();
    const scope = new ExtensionResourceScope();
    tools.register(scope, 'owner', spec(1));
    const replacement = tools.register(scope, 'owner', spec(2));
    scope.activate();
    const snapshot = tools.capture();
    expect(Object.isFrozen(snapshot.get('value')!.definition.inputSchema)).toBe(true);
    expect(Object.isFrozen(snapshot.get('value')!.definition.allowedCallers)).toBe(true);
    expect('set' in snapshot).toBe(false);
    snapshot.forEach((_value, _key, map) => {
      expect(map).toBe(snapshot);
    });
    await replacement.dispose();
    expect((await tools.capture().get('value')!.invoke(call, context())).content).toBe('1');
    expect((await snapshot.get('value')!.invoke(call, context())).content).toBe('2');
    await scope.dispose();
  });

  it('reuses captured bindings across same-source replacement but rejects retired owners', async () => {
    const tools = new ExtensionTools();
    const scope = new ExtensionResourceScope();
    tools.register(scope, 'counter', spec(1));
    expect(tools.capture().size).toBe(0);
    scope.activate();
    const before = tools.capture().get('value')!;
    tools.register(scope, 'counter', spec(2));
    const after = tools.capture().get('value')!;
    expect((await before.invoke(call, context())).data).toBe(1);
    expect((await after.invoke(call, context())).data).toBe(2);
    expect(before.source.revision).not.toBe(after.source.revision);
    expect(after.definition.allowedCallers).toEqual(['direct', 'programmatic']);
    await scope.dispose();
    expect(tools.capture().size).toBe(0);
    await expect(before.invoke(call, context())).rejects.toThrow(/RETIRED/);
  });

  it('requires explicit cross-source replacement and preserves a Host caller policy', async () => {
    const tools = new ExtensionTools();
    const scope = new ExtensionResourceScope();
    const base: CoreToolBinding = {
      definition: { ...spec(0), allowedCallers: ['direct'] },
      source: { kind: 'host', id: 'host', revision: '1' },
      invoke: async () => ({ content: 'host' })
    };
    tools.register(scope, 'value', spec(1));
    scope.activate();
    expect(() => tools.capture([base])).toThrow(/CONFLICT/);
    tools.register(scope, 'value', { ...spec(2), override: 'replace' });
    expect(tools.capture([base]).get('value')!.definition.allowedCallers).toEqual(['direct']);
    await scope.dispose();
  });

  it('keeps startup wrapper dependency validation but omits missing runtime sources', async () => {
    const tools = new ExtensionTools();
    const scope = new ExtensionResourceScope();
    tools.register(scope, 'wrapper', {
      ...spec(0),
      override: 'wrap',
      execute: (input, _call, next) => next(input)
    });
    expect(() => tools.capture([], true)).toThrow(/DEPENDENCY_MISSING/);
    scope.activate();
    expect(tools.capture().has('value')).toBe(false);
    const base: CoreToolBinding = {
      definition: spec(0),
      source: { kind: 'host', id: 'backend', revision: '1' },
      invoke: async () => ({ content: 'backend' })
    };
    expect(tools.capture([base]).has('value')).toBe(true);
    expect(tools.capture().has('value')).toBe(false);
    await scope.dispose();
  });

  it('inherits lower tool scope for wrappers but not explicit replacements', async () => {
    const tools = new ExtensionTools();
    const scope = new ExtensionResourceScope();
    const base: CoreToolBinding = {
      definition: { ...spec(0), agentScope: 'ROOT_ONLY' },
      source: { kind: 'host', id: 'root', revision: '1' },
      invoke: async () => ({ content: 'root' })
    };
    tools.register(scope, 'wrapper', {
      ...spec(0),
      override: 'wrap',
      execute: (input, _call, next) => next(input)
    });
    scope.activate();
    expect(tools.capture([base]).get('value')!.definition.agentScope).toBe('ROOT_ONLY');
    tools.register(scope, 'replacement', { ...spec(1), override: 'replace' });
    expect(tools.capture([base]).get('value')!.definition.agentScope).toBeUndefined();
    await scope.dispose();
  });

  it('rebuilds wrapper layers for future snapshots without changing an in-flight chain', async () => {
    const tools = new ExtensionTools();
    const a = new ExtensionResourceScope();
    const b = new ExtensionResourceScope();
    const c = new ExtensionResourceScope();
    tools.register(a, 'a', spec(1));
    const middle = tools.register(b, 'b', {
      ...spec(0),
      override: 'wrap',
      execute: async (input, _call, next) => ({
        content: String(Number((await next(input)).content) + 2)
      })
    });
    tools.register(c, 'c', {
      ...spec(0),
      override: 'wrap',
      execute: async (input, _call, next) => ({
        content: String(Number((await next(input)).content) * 3)
      })
    });
    a.activate();
    b.activate();
    c.activate();
    const old = tools.capture().get('value')!;
    await middle.dispose();
    expect((await old.invoke(call, context())).content).toBe('9');
    expect((await tools.capture().get('value')!.invoke(call, context())).content).toBe('3');
    await c.dispose();
    await b.dispose();
    await a.dispose();
  });
});
