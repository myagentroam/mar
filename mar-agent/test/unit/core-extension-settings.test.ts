import { extensionToolRuntime } from '../../src/sdk/extension-tool-runtime.js';
import { effectiveInstructions } from './support/model-context.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentError } from '../../src/index.js';
import { ExtensionManager } from '../../src/extensions/manager.js';
import type { SessionExtensionContext } from '../../src/extensions/contracts.js';
import type { ExtensionSettingsBackend } from '../../src/extensions/settings.js';
import type { ExtensionJsonValue } from '../../src/extensions/data.js';
import {
  fixture as sdkFixture,
  answer,
  call,
  cleanupCoreFixtures
} from './support/core-extension-fixture.js';

const managers: ExtensionManager[] = [];
afterEach(async () => {
  await cleanupCoreFixtures();
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});
function backend() {
  let revision = 0;
  const values: Record<string, ExtensionJsonValue> = {
    enabled: false,
    locked: 'policy',
    secret: 'explicit-bound-secret',
    structure: { nested: [1] }
  };
  const calls: {
    key?: string;
    extensionId?: string | undefined;
    executionId?: string | undefined;
    entry: string;
  }[] = [];
  const definitions = [
    { key: 'enabled', schema: { type: 'boolean' }, source: 'application', writable: true },
    { key: 'locked', schema: { type: 'string' }, source: 'policy', writable: false },
    {
      key: 'secret',
      schema: { type: 'string' },
      source: 'application',
      writable: true,
      sensitive: true
    },
    { key: 'structure', schema: { type: 'object' }, source: 'application', writable: true }
  ];
  const bound: ExtensionSettingsBackend = {
    async describe(_input, call) {
      call.signal.throwIfAborted();
      return { revision, definitions };
    },
    async read(input, call) {
      call.signal.throwIfAborted();
      return { revision, values: input.scope === 'absent-source' ? {} : values };
    },
    async update(input, call) {
      call.signal.throwIfAborted();
      calls.push({
        key: input.key,
        extensionId: call.extensionId,
        executionId: call.executionId,
        entry: call.entry
      });
      if (input.expectedRevision !== undefined && input.expectedRevision !== revision)
        throw new AgentError('MAR_AGENT_SETTINGS_REVISION_CONFLICT', 'Settings revision changed.');
      const row = definitions.find((row) => row.key === input.key);
      if (!row) throw new AgentError('MAR_AGENT_SETTINGS_KEY_UNKNOWN', 'Setting key is unknown.');
      if (!row.writable || (row.schema.type !== 'object' && typeof input.value !== row.schema.type))
        return {
          revision,
          status: 'denied',
          reason: {
            code: 'SETTINGS_VALUE_DENIED',
            message: 'Setting is locked or its value does not fit.'
          }
        };
      const changed = JSON.stringify(values[input.key]) !== JSON.stringify(input.value);
      if (changed) {
        values[input.key] = input.value;
        revision++;
      }
      return { revision, status: changed ? 'updated' : 'unchanged', value: values[input.key]! };
    }
  };
  return { bound, values, definitions, calls };
}
async function fixture(settings: ExtensionSettingsBackend = backend().bound) {
  let context!: SessionExtensionContext;
  const facts: unknown[] = [];
  const manager = new ExtensionManager({
    toolRuntime: extensionToolRuntime,
    extensions: [
      {
        id: 'bound',
        apiVersion: '1.0',
        bindings: { settings },
        requires: [{ id: 'settings' }],
        attachSession(value) {
          context = value;
          value.hooks.observe('settings.completed', (fact) => {
            facts.push(fact);
          });
        }
      }
    ],
    capabilities: ['settings'],
    busyExcept: () => false
  });
  managers.push(manager);
  await manager.prepare('session', new AbortController().signal);
  return { manager, context, facts };
}

describe('Core explicitly bound settings', () => {
  it('reads source/schema/value snapshots, includes explicitly bound secrets, and does not expose them in completion facts', async () => {
    const { bound, definitions } = backend();
    const { context, facts } = await fixture(bound);
    expect(context.capabilities.has('settings')).toBe(true);
    expect((await context.settings!.describe()).definitions).toEqual(definitions);
    const snapshot = await context.settings!.read();
    expect(snapshot.values.secret).toBe('explicit-bound-secret');
    expect(await context.settings!.read({ scope: 'absent-source' })).toEqual({
      revision: 0,
      values: {}
    });
    expect(facts).toEqual([
      { operation: 'describe', revision: 0 },
      { operation: 'read', revision: 0 },
      { operation: 'read', revision: 0, scope: 'absent-source' }
    ]);
    expect(JSON.stringify(facts)).not.toContain('secret');
  });

  it('commits real backend changes/CAS and preserves explicit denied/unchanged results', async () => {
    const { bound, values, calls } = backend();
    const { context } = await fixture(bound);
    expect(
      await context.settings!.update({ key: 'enabled', value: true, expectedRevision: 0 })
    ).toEqual({ status: 'updated', revision: 1, value: true });
    expect(values.enabled).toBe(true);
    expect(
      await context.settings!.update({ key: 'enabled', value: true, expectedRevision: 1 })
    ).toEqual({ status: 'unchanged', revision: 1, value: true });
    expect(await context.settings!.update({ key: 'locked', value: 'override' })).toMatchObject({
      status: 'denied',
      revision: 1
    });
    expect(await context.settings!.update({ key: 'enabled', value: 'invalid' })).toMatchObject({
      status: 'denied'
    });
    await expect(context.settings!.update({ key: 'unknown', value: true })).rejects.toMatchObject({
      code: 'MAR_AGENT_SETTINGS_KEY_UNKNOWN'
    });
    expect(calls[0]).toEqual({
      key: 'enabled',
      extensionId: 'bound',
      executionId: undefined,
      entry: 'native-api'
    });
  });

  it('does not turn simultaneous CAS writes into an unsafe read-then-write', async () => {
    const { context } = await fixture();
    const results = await Promise.allSettled([
      context.settings!.update({ key: 'enabled', value: true, expectedRevision: 0 }),
      context.settings!.update({ key: 'secret', value: 'new-value', expectedRevision: 0 })
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({
      code: 'MAR_AGENT_SETTINGS_REVISION_CONFLICT'
    });
    expect((await context.settings!.read()).values.secret).toBe('explicit-bound-secret');
  });

  it('copies mutable input and output JSON, including ordinary __proto__ keys', async () => {
    const { bound, values } = backend();
    const { context } = await fixture(bound);
    const input = {
      key: 'structure',
      value: Object.fromEntries([
        ['__proto__', { valid: true }],
        ['nested', [2]]
      ])
    };
    const pending = context.settings!.update(input);
    const nested = input.value.nested;
    if (!Array.isArray(nested)) throw new Error('Expected a nested array.');
    nested.push(99);
    await pending;
    expect((values.structure as { nested: number[] }).nested).toEqual([2]);
    expect(Object.hasOwn(values.structure as object, '__proto__')).toBe(true);
    const view = await context.settings!.read();
    (view.values.structure as { nested: number[] }).nested.push(3);
    expect((values.structure as { nested: number[] }).nested).toEqual([2]);
    const description = await context.settings!.describe();
    (description.definitions[0]!.schema as { type: string }).type = 'null';
    expect((await context.settings!.describe()).definitions[0]!.schema).toEqual({
      type: 'boolean'
    });
  });

  it('preserves original leaf metadata when wrappers hide rows or change update results', async () => {
    const { context, facts } = await fixture();
    context.hooks.intercept('settings.describe', async (input, _call, next) => {
      const result = await next(input);
      return { ...result, definitions: result.definitions.filter((row) => row.key !== 'locked') };
    });
    context.hooks.intercept('settings.update', async (input, _call, next) => {
      const result = await next(input);
      return {
        status: 'denied',
        revision: result.revision,
        reason: { code: 'WRAPPED', message: 'Hidden from this caller.' }
      };
    });
    expect(
      (await context.settings!.describe()).definitions.some((row) => row.key === 'locked')
    ).toBe(false);
    expect(await context.settings!.update({ key: 'enabled', value: true })).toMatchObject({
      status: 'denied'
    });
    expect((await context.settings!.read()).values.enabled).toBe(true);
    expect(facts).toContainEqual({ operation: 'update', revision: 1, status: 'updated' });
  });

  it('cancels nested writes before dispatch and rejects stale owners without rolling back committed configuration', async () => {
    const { bound, values, calls } = backend();
    const { context, manager } = await fixture(bound);
    await context.settings!.update({ key: 'enabled', value: true });
    const controller = new AbortController();
    const reason = new Error('cancel-settings');
    controller.abort(reason);
    await expect(
      context.settings!.update({ key: 'enabled', value: false, signal: controller.signal })
    ).rejects.toBe(reason);
    expect(calls).toHaveLength(1);
    await manager.dispose();
    await expect(context.settings!.read()).rejects.toMatchObject({
      code: 'MAR_AGENT_EXTENSION_RETIRED'
    });
    expect(values.enabled).toBe(true);
  });

  it('projects actual per-extension binding availability and disables only missing/invalid bound dependencies', async () => {
    const { bound } = backend();
    const contexts: Record<string, SessionExtensionContext> = {};
    const manager = new ExtensionManager({
      toolRuntime: extensionToolRuntime,
      extensions: [
        {
          id: 'provided',
          apiVersion: '1.0',
          bindings: { settings: bound },
          attachSession(value) {
            contexts.provided = value;
          }
        },
        {
          id: 'none',
          apiVersion: '1.0',
          attachSession(value) {
            contexts.none = value;
          }
        },
        {
          id: 'required',
          apiVersion: '1.0',
          requires: [{ id: 'settings' }],
          attachSession() {
            throw new Error('must not attach');
          }
        },
        {
          id: 'invalid',
          apiVersion: '1.0',
          bindings: { settings: {} },
          attachSession() {
            throw new Error('must not attach');
          }
        }
      ],
      capabilities: ['settings'],
      busyExcept: () => false
    });
    managers.push(manager);
    await manager.prepare('session', new AbortController().signal);
    expect(contexts.provided!.settings).toBeDefined();
    expect(contexts.none!.settings).toBeUndefined();
    expect(contexts.none!.capabilities.has('settings')).toBe(false);
    expect(manager.diagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MAR_AGENT_EXTENSION_DEPENDENCY_MISSING',
          extensionId: 'required'
        }),
        expect.objectContaining({
          code: 'MAR_AGENT_SETTINGS_BINDING_INVALID',
          extensionId: 'invalid'
        })
      ])
    );
  });

  it.each([false, true])(
    'invokes the existing SDK settings writer under model/Code Mode lineage and affects only the next execution (%s)',
    async (codeMode) => {
      let context!: SessionExtensionContext;
      const bound = backend();
      let updateInstruction!: (value: string) => void;
      const calls: unknown[] = [];
      const settings: ExtensionSettingsBackend = {
        ...bound.bound,
        async update(input, call) {
          calls.push({ executionId: call.executionId, entry: call.entry });
          const result = await bound.bound.update(input, call);
          if (result.status === 'updated') updateInstruction('CORE_BOUND_NEXT_INSTRUCTION');
          return result;
        }
      };
      const { agent, session, adapter } = await sdkFixture(
        [
          {
            id: 'sdk-settings',
            apiVersion: '1.0',
            bindings: { settings },
            attachSession(value) {
              context = value;
              value.tools.register({
                name: 'settings_probe',
                description: 'Update explicitly bound settings',
                inputSchema: { type: 'object' },
                execute: async () => {
                  const result = await value.settings!.update({ key: 'enabled', value: true });
                  return { content: result.status };
                }
              });
            }
          }
        ],
        (_request, index) =>
          index === 0
            ? codeMode
              ? call('code_exec', { code: 'observe.result(await tools.settings_probe({}));' })
              : call('settings_probe', {})
            : answer(),
        codeMode
      );
      updateInstruction = agent.setSystemInstruction;
      const first = await session.run({ prompt: 'set bound instruction' }).result();
      expect(first.status).toBe('completed');
      expect(calls).toEqual([
        { executionId: first.executionId, entry: codeMode ? 'programmatic' : 'direct' }
      ]);
      expect(
        adapter.requests.every(
          (request) => !effectiveInstructions(request).includes('CORE_BOUND_NEXT_INSTRUCTION')
        )
      ).toBe(true);
      await session.run({ prompt: 'use future instruction' }).result();
      expect(effectiveInstructions(adapter.requests.at(-1)!)).toContain(
        'CORE_BOUND_NEXT_INSTRUCTION'
      );
      expect((await context.settings!.read()).values.enabled).toBe(true);
    }
  );

  it('rejects non-JSON updates, malformed metadata/results and missing handlers with stable codes', async () => {
    const { bound } = backend();
    const { context } = await fixture(bound);
    await expect(
      context.settings!.update({ key: 'structure', value: (() => {}) as never })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SETTINGS_INPUT_INVALID' });
    await expect(
      context.settings!.update({ key: 'enabled', value: true, expectedRevision: -1 })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SETTINGS_INPUT_INVALID' });
    await expect(context.settings!.read([] as never)).rejects.toMatchObject({
      code: 'MAR_AGENT_SETTINGS_INPUT_INVALID'
    });
    bound.read = async () => ({ revision: 0, values: [] }) as never;
    await expect(context.settings!.read()).rejects.toMatchObject({
      code: 'MAR_AGENT_SETTINGS_OUTPUT_INVALID'
    });
    bound.describe = async () =>
      ({ revision: 0, definitions: [{ key: 'x', schema: {}, writable: true }] }) as never;
    await expect(context.settings!.describe()).rejects.toMatchObject({
      code: 'MAR_AGENT_SETTINGS_OUTPUT_INVALID'
    });
    bound.describe = async () =>
      ({
        revision: 0,
        definitions: [{ key: 'x', schema: {}, source: 'bound', writable: true, sensitive: 'yes' }]
      }) as never;
    await expect(context.settings!.describe()).rejects.toMatchObject({
      code: 'MAR_AGENT_SETTINGS_OUTPUT_INVALID'
    });
    bound.update = undefined as never;
    await expect(context.settings!.update({ key: 'enabled', value: true })).rejects.toMatchObject({
      code: 'MAR_AGENT_HOST_PORT_UNAVAILABLE'
    });
  });

  it('propagates cancellation through an in-flight Hook without dispatching a late writer', async () => {
    const { bound, values, calls } = backend();
    const { context } = await fixture(bound);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hook = context.hooks.intercept('settings.update', async (input, call, next) => {
      entered();
      await new Promise<void>((resolve) => {
        call.signal.addEventListener('abort', () => resolve(), { once: true });
        if (call.signal.aborted) resolve();
      });
      return next(input);
    });
    const controller = new AbortController();
    const reason = new Error('stop-hook-write');
    const pending = context.settings!.update({
      key: 'enabled',
      value: true,
      signal: controller.signal
    });
    const outcome = pending.catch((error) => error);
    await started;
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(values.enabled).toBe(false);
    expect(calls).toHaveLength(0);
    await hook.dispose();
    expect(await context.settings!.update({ key: 'enabled', value: true })).toMatchObject({
      status: 'updated'
    });
  });

  it('uses the new revision binding while retiring the old facade without resetting real backend state', async () => {
    let revision = 'one';
    const contexts: SessionExtensionContext[] = [];
    const first = backend();
    const second = backend();
    const manager = new ExtensionManager({
      toolRuntime: extensionToolRuntime,
      extensions: {
        async resolve() {
          return {
            revision,
            extensions: [
              {
                id: 'versioned-settings',
                apiVersion: '1.0' as const,
                bindings: { settings: revision === 'one' ? first.bound : second.bound },
                attachSession(value: SessionExtensionContext) {
                  contexts.push(value);
                }
              }
            ]
          };
        }
      },
      capabilities: ['settings'],
      busyExcept: () => false
    });
    managers.push(manager);
    await manager.prepare('session', new AbortController().signal);
    await contexts[0]!.settings!.update({ key: 'enabled', value: true });
    revision = 'two';
    await manager.prepare('session', new AbortController().signal);
    expect((await contexts[1]!.settings!.read()).values.enabled).toBe(false);
    expect(first.values.enabled).toBe(true);
    await expect(contexts[0]!.settings!.read()).rejects.toMatchObject({
      code: 'MAR_AGENT_EXTENSION_RETIRED'
    });
  });
});
