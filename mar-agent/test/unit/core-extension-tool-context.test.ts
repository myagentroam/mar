import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentExtension, SessionExtensionContext } from '../../src/extensions/contracts.js';
import type { ExtensionToolRef } from '../../src/extensions/tools.js';
import type { ExtensionServiceKey } from '../../src/extensions/services.js';
import { answer, call, fixture, cleanupCoreFixtures } from './support/core-extension-fixture.js';
import { activeSessionDirectory } from '../support/jsonl-session-path.js';
import { createSubagentExtension } from '../../extensions/subagent/src/index.js';
import type { Agent } from '../../src/index.js';
import {
  publicExtensionToolEventData,
  publicToolEventInput
} from '../../src/tools/output-projection.js';

afterEach(cleanupCoreFixtures);

describe('tool permission and wait context', () => {
  it('runs a native service with actual caller identity and the owning session lifetime', async () => {
    type Probe = { run(): Promise<unknown> };
    const key: ExtensionServiceKey<Probe> = {
      id: 'native-probe',
      scope: 'session',
      bindConsumer: (_service, consumer) => ({ run: () => consumer.run(async (call) => call) })
    };
    let probe: Probe | undefined;
    const observed: Array<{ outer: unknown; inner: unknown }> = [];
    const service: AgentExtension = {
      id: 'native-service-provider',
      apiVersion: '1.0',
      provides: [{ key }],
      attachSession(context) {
        context.services.provide(key, { async run() {} });
      }
    };
    const consumer: AgentExtension = {
      id: 'native-service-consumer',
      apiVersion: '1.0',
      serviceDependencies: [{ key }],
      attachSession(context) {
        const forgedKey: ExtensionServiceKey<Probe> = {
          ...key,
          bindConsumer: () => {
            throw new Error('caller-supplied binder must not run');
          }
        };
        probe = context.services.consume(forgedKey)!;
        context.tools.register({
          name: 'native_service_probe',
          description: 'Exercise a native service.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          async execute(_input, outer) {
            observed.push({ outer, inner: await probe!.run() });
            return { content: 'done' };
          }
        });
      }
    };
    const { agent, session } = await fixture([service, consumer], (_request, index) =>
      index === 0 ? call('native_service_probe', {}) : answer()
    );
    const execution = session.run({ prompt: 'probe' });
    expect((await execution.result()).status).toBe('completed');
    const { outer, inner } = observed[0] as {
      outer: Record<string, unknown>;
      inner: Record<string, unknown>;
    };
    expect(inner).toMatchObject({
      entry: outer.entry,
      sessionId: session.id,
      executionId: execution.executionId,
      extensionId: 'native-service-consumer',
      parentOperationId: outer.operationId
    });
    const idle = (await probe!.run()) as Record<string, unknown>;
    expect(idle).toMatchObject({
      entry: 'native-api',
      sessionId: session.id,
      extensionId: 'native-service-consumer'
    });
    expect(idle.ownerInstanceId).toBe(inner.ownerInstanceId);
    expect(idle).not.toHaveProperty('executionId');
    await agent.dispose();
    await expect(probe!.run()).rejects.toThrow();
  });
  it('drops oversized and throwing public projections without recovering raw values', () => {
    expect(publicExtensionToolEventData({ text: 'x'.repeat(8193) })).toBeUndefined();
    expect(publicToolEventInput({ id: 'x'.repeat(8193), secret: 'private' }, ['id'])).toEqual({});
    const input = Object.defineProperty({}, 'id', {
      enumerable: true,
      get() {
        throw new Error('private');
      }
    });
    expect(publicToolEventInput(input, ['id'])).toEqual({});
  });
  it.each([false, true])(
    'projects explicit public tool events without changing inputs (invalid=%s)',
    async (invalid) => {
      const calls: unknown[] = [];
      const extension: AgentExtension = {
        id: 'public-event',
        apiVersion: '1.0',
        attachSession(context) {
          context.tools.register({
            name: 'event_probe',
            description: 'Inspect projection.',
            eventInputFields: ['id'],
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string' }, image: { type: 'string' } },
              required: ['id', 'image'],
              additionalProperties: false
            },
            execute(input) {
              calls.push(input);
              return {
                content: 'private model result',
                data: { private: 'secret-result' },
                eventData: { id: 'safe' },
                eventSummary: 'public receipt'
              };
            }
          });
        }
      };
      const input = {
        id: 'safe',
        image: invalid ? 123 : 'secret-image',
        ...(invalid ? { unknown: 'secret-extra' } : {})
      };
      const { agent, session } = await fixture([extension], (_request, index) =>
        index === 0 ? call('event_probe', input) : answer()
      );
      const run = session.run({ prompt: 'inspect projection' });
      const events = [];
      for await (const event of run) events.push(event);
      expect((await run.result()).status).toBe('completed');
      expect(
        events.find((event) => event.type === 'tool.started' && event.toolName === 'event_probe')
      ).toMatchObject({ input: { id: 'safe' } });
      const toolEvents = events.filter(
        (event) =>
          event.type.startsWith('tool.') && 'toolName' in event && event.toolName === 'event_probe'
      );
      expect(JSON.stringify(toolEvents)).not.toContain('secret-');
      expect(JSON.stringify(await agent.sessionHistory(session.id))).not.toContain('secret-');
      if (invalid) {
        expect(calls).toEqual([]);
        expect(toolEvents).toContainEqual(expect.objectContaining({ type: 'tool.failed' }));
      } else {
        expect(calls).toEqual([input]);
        expect(toolEvents).toContainEqual(
          expect.objectContaining({
            type: 'tool.completed',
            summary: 'public receipt',
            data: { id: 'safe' }
          })
        );
      }
    }
  );

  it.each(['auto', 'full-access'] as const)(
    'exposes the actual tool execution permission mode: %s',
    async (mode) => {
      const seen: unknown[] = [];
      const extension: AgentExtension = {
        id: 'mode-probe',
        apiVersion: '1.0',
        attachSession(context) {
          context.tools.register({
            name: 'mode_probe',
            description: 'Inspect mode.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            execute(_input, call) {
              seen.push(call.permissionMode);
              return { content: 'ok' };
            }
          });
        }
      };
      const { session } = await fixture([extension], (_request, index) =>
        index === 0 ? call('mode_probe', {}) : answer()
      );
      await session.run({ prompt: 'test', permissionMode: mode }).result();
      expect(seen).toEqual([mode]);
    }
  );

  it.each([
    { decision: 'APPROVED' as const, change: false, approved: true },
    { decision: 'APPROVED' as const, change: true, approved: false },
    { decision: 'REJECTED' as const, change: false, approved: null }
  ])(
    'exposes actual approval only for the unchanged approved invocation: $decision/$change',
    async ({ decision, change, approved }) => {
      const seen: Array<{ target: unknown; permission: unknown; hasWait: boolean }> = [];
      const extension: AgentExtension = {
        id: 'approval-context',
        apiVersion: '1.0',
        attachSession(value) {
          value.tools.register({
            name: 'approval_probe',
            description: 'Test call-scoped permission.',
            inputSchema: {
              type: 'object',
              properties: { target: { type: 'string' } },
              required: ['target'],
              additionalProperties: false
            },
            async execute(input, context) {
              seen.push({
                target: (input as { target: string }).target,
                permission: context.permission,
                hasWait: context.waitInterrupt !== undefined
              });
              return { content: 'done' };
            }
          });
          if (change)
            value.hooks.intercept('tool.invoke', async (input, _context, next) =>
              next({ ...input, arguments: { target: 'changed' } })
            );
        }
      };
      const { session } = await fixture(
        [extension],
        (_request, index) =>
          index === 0
            ? call('approval_probe', {
                target: 'original',
                permission: { action: 'ask', reason: 'Confirm target.' }
              })
            : answer(),
        false,
        false,
        { approval: async () => decision }
      );
      await session.run({ prompt: 'test', permissionMode: 'auto' }).result();
      if (approved === null) expect(seen).toEqual([]);
      else
        expect(seen).toEqual([
          {
            target: change ? 'changed' : 'original',
            permission: approved ? { decision: 'approved' } : undefined,
            hasWait: true
          }
        ]);
    }
  );

  it('does not pass approval to a modified wrapper continuation or a nested tool call', async () => {
    const seen: unknown[] = [];
    const base: AgentExtension = {
      id: 'base-probe',
      apiVersion: '1.0',
      attachSession(value) {
        value.tools.register({
          name: 'base_probe',
          description: 'Probe approval.',
          inputSchema: {
            type: 'object',
            properties: { target: { type: 'string' } },
            required: ['target'],
            additionalProperties: false
          },
          async execute(_input, context) {
            seen.push(context.permission);
            return { content: 'ok' };
          }
        });
      }
    };
    const wrapper: AgentExtension = {
      id: 'wrapper-probe',
      apiVersion: '1.0',
      attachSession(value) {
        value.tools.register({
          name: 'base_probe',
          description: 'Wrap probe.',
          override: 'wrap',
          inputSchema: {
            type: 'object',
            properties: { target: { type: 'string' } },
            required: ['target'],
            additionalProperties: false
          },
          async execute(_input, context, next) {
            seen.push(context.permission);
            await value.tools.invoke({ name: 'nested_probe', arguments: {} });
            return next({ target: 'changed' });
          }
        });
        value.tools.register({
          name: 'nested_probe',
          description: 'Nested probe.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          async execute(_input, context) {
            seen.push(context.permission);
            return { content: 'ok' };
          }
        });
      }
    };
    const { session } = await fixture(
      [base, wrapper],
      (_request, index) =>
        index === 0
          ? call('base_probe', {
              target: 'original',
              permission: { action: 'ask', reason: 'Confirm.' }
            })
          : answer(),
      false,
      false,
      { approval: async () => 'APPROVED' }
    );
    await session.run({ prompt: 'test', permissionMode: 'auto' }).result();
    expect(seen).toEqual([{ decision: 'approved' }, undefined, undefined]);
  });

  it('does not retain approval when an identity parser and wrapper mutate nested arguments in place', async () => {
    const seen: unknown[] = [];
    const definition = {
      type: 'object',
      properties: {
        target: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false
        }
      },
      required: ['target'],
      additionalProperties: false
    };
    const base: AgentExtension = {
      id: 'identity-base',
      apiVersion: '1.0',
      attachSession(value) {
        value.tools.register({
          name: 'identity_probe',
          description: 'Probe approval.',
          inputSchema: definition,
          async execute(input, context) {
            seen.push({ input, permission: context.permission });
            return { content: 'ok' };
          }
        });
      }
    };
    const wrapper: AgentExtension = {
      id: 'identity-wrapper',
      apiVersion: '1.0',
      attachSession(value) {
        value.tools.register({
          name: 'identity_probe',
          description: 'Wrap approval.',
          override: 'wrap',
          inputSchema: definition,
          parseInput: (input) => input,
          async execute(input, _context, next) {
            (input as { target: { id: string } }).target.id = 'changed';
            return next(input);
          }
        });
      }
    };
    const { session } = await fixture(
      [base, wrapper],
      (_request, index) =>
        index === 0
          ? call('identity_probe', {
              target: { id: 'original' },
              permission: { action: 'ask', reason: 'Confirm.' }
            })
          : answer(),
      false,
      false,
      { approval: async () => 'APPROVED' }
    );
    await session.run({ prompt: 'test', permissionMode: 'auto' }).result();
    expect(seen).toEqual([{ input: { target: { id: 'changed' } }, permission: undefined }]);
  });

  it('does not expose approval when a custom parser mutates approved arguments', async () => {
    const seen: unknown[] = [];
    const extension: AgentExtension = {
      id: 'parser-probe',
      apiVersion: '1.0',
      attachSession(value) {
        value.tools.register({
          name: 'parser_probe',
          description: 'Probe parser.',
          inputSchema: {
            type: 'object',
            properties: { target: { type: 'string' } },
            required: ['target'],
            additionalProperties: false
          },
          parseInput(input) {
            (input as { target: string }).target = 'other';
            return input;
          },
          async execute(input, context) {
            seen.push({ input, permission: context.permission });
            return { content: 'ok' };
          }
        });
      }
    };
    const { session } = await fixture(
      [extension],
      (_request, index) =>
        index === 0
          ? call('parser_probe', {
              target: 'original',
              permission: { action: 'ask', reason: 'Confirm.' }
            })
          : answer(),
      false,
      false,
      { approval: async () => 'APPROVED' }
    );
    await session.run({ prompt: 'test', permissionMode: 'auto' }).result();
    expect(seen).toEqual([{ input: { target: 'other' }, permission: undefined }]);
  });
});

describe('Execution tool sources outside model tool handlers', () => {
  it.each(['prompt.compose', 'model.request'] as const)(
    'uses real Todo and read sources in %s',
    async (key) => {
      let context!: SessionExtensionContext;
      let visited = 0;
      const facts: Array<{ name: string; executionId?: string }> = [];
      const extension: AgentExtension = {
        id: 'hooks',
        apiVersion: '1.0',
        attachSession(value) {
          context = value;
          value.hooks.observe('tool.attempt.completed', (fact, call) => {
            facts.push({
              name: fact.name,
              ...(call.executionId ? { executionId: call.executionId } : {})
            });
          });
          value.hooks.intercept(key, async (input, call, next) => {
            visited++;
            const refs = value.tools.catalog();
            expect(refs.some((ref) => ref.definition.name === 'todo_read')).toBe(true);
            expect((await value.tools.check({ name: 'todo_read', arguments: {} })).available).toBe(
              true
            );
            const todo = await value.tools.invoke({ name: 'todo_read', arguments: {} });
            expect(todo.data).toMatchObject({ revision: 0, items: [] });
            await value.tools.invoke({
              name: 'todo_write',
              arguments: {
                items: [{ id: 'hook', step: 'Hook write', status: 'completed' }]
              }
            });
            const read = await value.tools.invoke({
              name: 'read',
              arguments: { reads: [{ path: 'input.txt' }] }
            });
            expect(read.data).toMatchObject({ results: [{ text: 'extension-data' }] });
            expect(call.executionId).toBeDefined();
            return next(input);
          });
        }
      };
      const { session, adapter } = await fixture([extension], answer);
      const handle = session.run({ prompt: 'hook' });
      expect((await handle.result()).status).toBe('completed');
      expect(visited).toBe(1);
      expect(facts.map((fact) => fact.name)).toEqual(['todo_read', 'todo_write', 'read']);
      expect(new Set(facts.map((fact) => fact.executionId))).toEqual(new Set([handle.executionId]));
      expect(adapter.requests).toHaveLength(1);
      expect(
        adapter.requests[0]!.messages.filter((message) => message.role === 'tool')
      ).toHaveLength(0);
      expect(
        (await context.session!.messages()).messages.filter((message) => message.role === 'tool')
      ).toHaveLength(0);
    }
  );

  it('uses the same bound Host tool and Skill catalog without reopening the Host directory', async () => {
    let calls = 0;
    let invoked = 0;
    const extension: AgentExtension = {
      id: 'hooks',
      apiVersion: '1.0',
      attachSession(value) {
        value.hooks.intercept('model.request', async (input, _call, next) => {
          const skill = await value.tools.invoke({ name: 'skill', arguments: { name: 'web' } });
          expect(skill.content).toContain('Bound web instructions');
          const result = await value.tools.invoke({ name: 'web_probe', arguments: {} });
          expect(result.content).toBe('web-bound');
          invoked++;
          return next(input);
        });
      }
    };
    const { session, host } = await fixture([extension], answer, false, false, {
      extensions: {
        tools: [{ name: 'web_probe', description: 'Web', inputSchema: { type: 'object' } }],
        skills: [
          {
            name: 'web',
            description: 'Web',
            requiredTools: ['web_probe'],
            load: async () => 'Bound web instructions'
          }
        ],
        executeTool: async () => {
          calls++;
          return { content: 'web-bound' };
        }
      }
    });
    const original = host.listExecutionExtensions.bind(host);
    let catalogs = 0;
    host.listExecutionExtensions = async (...input) => {
      catalogs++;
      return original(...input);
    };
    expect((await session.run({ prompt: 'web' }).result()).status).toBe('completed');
    expect(invoked).toBe(1);
    expect(calls).toBe(1);
    expect(catalogs).toBe(1);
  });

  it.each(['ANTHROPIC_MESSAGES', 'OPENAI_RESPONSES'] as const)(
    'refreshes Host Web bindings and Skill dependencies without rebinding old refs in %s',
    async (protocol) => {
      let context!: SessionExtensionContext;
      let old!: ExtensionToolRef;
      let visits = 0;
      let attaches = 0;
      let catalogs = 0;
      let guards = 0;
      const effects: string[] = [];
      const extension: AgentExtension = {
        id: 'web-wrapper',
        apiVersion: '1.0',
        attachSession(value) {
          attaches++;
          context = value;
          value.tools.register({
            name: 'web_search',
            description: 'Wrapped Host search.',
            override: 'wrap',
            inputSchema: { type: 'object' },
            async execute(input, _call, next) {
              const result = await next(input);
              return { ...result, content: `wrapped:${result.content}` };
            }
          });
          value.hooks.intercept('model.request', async (input, _call, next) => {
            visits++;
            const refs = value.tools.catalog();
            const current = refs.find((ref) => ref.definition.name === 'web_search')!;
            expect(current.definition.allowedCallers).toEqual(['direct']);
            if (visits === 1) old = current;
            else
              await expect(
                value.tools.invoke({ name: 'web_search', arguments: {}, ref: old })
              ).rejects.toThrow(/TOOL_NOT_AVAILABLE/);
            expect(
              (await value.tools.invoke({ name: 'web_search', arguments: {}, ref: current }))
                .content
            ).toBe(`wrapped:source-${visits}`);
            if (visits < 3) {
              const skill = await value.tools.invoke({
                name: 'skill',
                arguments: { name: 'web-helper' }
              });
              expect(skill.content).toContain(`Web instructions ${visits}`);
              expect((await value.tools.invoke({ name: 'web_fetch', arguments: {} })).content).toBe(
                `fetch-${visits}`
              );
            } else {
              expect(refs.some((ref) => ref.definition.name === 'web_fetch')).toBe(false);
              await expect(
                value.tools.invoke({ name: 'skill', arguments: { name: 'web-helper' } })
              ).rejects.toThrow(/TOOL_INPUT_INVALID|TOOL_NOT_AVAILABLE/);
            }
            return next(input);
          });
        }
      };
      const { session, host } = await fixture(
        [extension],
        answer,
        false,
        false,
        {
          beforeToolExecute(input) {
            if (input.name === 'web_search' || input.name === 'web_fetch') guards++;
          },
          beforeOperationToolExecute: () => {}
        },
        protocol
      );
      const list = host.listExecutionExtensions.bind(host);
      host.listExecutionExtensions = async (...args) => {
        catalogs++;
        return list(...args);
      };
      for (const version of [1, 2, 3]) {
        const binding = host.bindExecutionExtensions({
          tools: [
            { name: 'web_search', description: 'Host search.', inputSchema: { type: 'object' } },
            { name: 'web_fetch', description: 'Host fetch.', inputSchema: { type: 'object' } }
          ],
          isToolAvailable: (name) => name !== 'web_fetch' || version < 3,
          skills: [
            {
              name: 'web-helper',
              description: 'Host Web help.',
              requiredTools: ['web_search', 'web_fetch'],
              load: async () => `Web instructions ${version}`
            }
          ],
          executeTool: async (input) => {
            effects.push(`${input.name}:${version}`);
            return {
              content: input.name === 'web_search' ? `source-${version}` : `fetch-${version}`
            };
          }
        });
        try {
          expect((await session.run({ prompt: `web version ${version}` }).result()).status).toBe(
            'completed'
          );
          expect(() => context.tools.catalog()).not.toThrow();
          expect(context.tools.catalog().some((ref) => ref.definition.name === 'web_search')).toBe(
            false
          );
          expect((await context.tools.check({ name: 'web_search', arguments: {} })).available).toBe(
            false
          );
          expect(
            (
              await context.tools.invoke({
                name: 'read',
                arguments: { reads: [{ path: 'input.txt' }] }
              })
            ).content
          ).toContain('extension-data');
        } finally {
          host.unbindExecutionMcp(binding);
        }
      }
      expect(attaches).toBe(1);
      expect(catalogs).toBe(3);
      expect(guards).toBe(5);
      expect(effects).toEqual([
        'web_search:1',
        'web_fetch:1',
        'web_search:2',
        'web_fetch:2',
        'web_search:3'
      ]);
    }
  );

  it('discovers and calls captured static MCP from a model request Hook', async () => {
    let reads = 0;
    let calls = 0;
    let visited = 0;
    const name = 'mcp__reference__probe';
    const extension: AgentExtension = {
      id: 'hooks',
      apiVersion: '1.0',
      attachSession(value) {
        value.hooks.intercept('model.request', async (input, call, next) => {
          expect((await value.tools.check({ name, arguments: {} })).available).toBe(true);
          const search = await value.tools.invoke({
            name: 'tool_search',
            arguments: { query: 'probe' }
          });
          expect(search.toolSearchTools?.some((tool) => tool.name === name)).toBe(true);
          expect((await value.tools.invoke({ name, arguments: {} })).content).toBe('mcp-bound');
          expect(call.executionId).toBeDefined();
          visited++;
          return next(input);
        });
      }
    };
    const { session } = await fixture([extension], answer, false, false, {
      mcpCatalog: () => {
        reads++;
        return {
          revision: '1',
          servers: [{ id: 'reference', name: 'Reference' }],
          tools: [
            {
              definition: { name, description: 'Probe', inputSchema: { type: 'object' } },
              serverId: 'reference',
              rawName: 'probe',
              sourceIdentity: 'reference/probe',
              definitionRevision: '1',
              lifetime: 'execution',
              exposure: 'deferred'
            }
          ]
        };
      },
      callMcp: async (_call, _signal, context) => {
        expect(context?.executionId).toBeDefined();
        expect(context?.expectedTool).toEqual({
          sourceIdentity: 'reference/probe',
          definitionRevision: '1'
        });
        calls++;
        return { content: 'mcp-bound' };
      }
    });
    expect((await session.run({ prompt: 'mcp' }).result()).status).toBe('completed');
    expect(visited).toBe(1);
    expect(calls).toBe(1);
    // Initial snapshot, the source guard, and the existing Local Host dispatch lookup.
    expect(reads).toBe(3);
  });

  it('does not revive an old Execution ref in idle or a subsequent Execution', async () => {
    let context!: SessionExtensionContext;
    let old!: ExtensionToolRef;
    let runs = 0;
    let rejected = false;
    const { session } = await fixture(
      [
        {
          id: 'hooks',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('model.request', async (input, _call, next) => {
              if (runs++ === 0) {
                old = value.tools.catalog().find((ref) => ref.definition.name === 'todo_read')!;
                expect(
                  (await value.tools.invoke({ name: 'todo_read', arguments: {}, ref: old })).data
                ).toBeDefined();
              } else {
                expect(
                  (await value.tools.check({ name: 'todo_read', arguments: {}, ref: old }))
                    .available
                ).toBe(false);
                await value.tools
                  .invoke({ name: 'todo_read', arguments: {}, ref: old })
                  .catch(() => {
                    rejected = true;
                  });
                expect(
                  (await value.tools.invoke({ name: 'todo_read', arguments: {} })).data
                ).toBeDefined();
              }
              return next(input);
            });
          }
        }
      ],
      answer
    );
    expect((await session.run({ prompt: 'first' }).result()).status).toBe('completed');
    expect(old).toBeDefined();
    expect(
      (await context.tools.check({ name: 'todo_read', arguments: {}, ref: old })).available
    ).toBe(false);
    await expect(
      context.tools.invoke({ name: 'todo_read', arguments: {}, ref: old })
    ).rejects.toThrow(/TOOL_NOT_AVAILABLE/);
    expect((await session.run({ prompt: 'next' }).result()).status).toBe('completed');
    expect(runs).toBe(2);
    expect(rejected).toBe(true);
  });

  it('does not inherit a finished physical tool frame in a detached native call', async () => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let later!: Promise<string>;
    const { session } = await fixture(
      [
        {
          id: 'hooks',
          apiVersion: '1.0',
          attachSession(value) {
            value.tools.register({
              name: 'detach',
              description: 'Detach',
              inputSchema: { type: 'object' },
              execute() {
                later = new Promise((resolve, reject) => {
                  setImmediate(async () => {
                    try {
                      await gate;
                      const ref = value.tools
                        .catalog()
                        .find((item) => item.definition.name === 'read')!;
                      const result = await value.tools.invoke({
                        name: 'read',
                        arguments: { reads: [{ path: 'input.txt' }] },
                        ref
                      });
                      resolve(result.content);
                    } catch (error) {
                      reject(error);
                    }
                  });
                });
                void later.catch(() => undefined);
                return { content: 'detached' };
              }
            });
          }
        }
      ],
      (_request, index) => (index === 0 ? call('detach', {}) : answer())
    );
    expect((await session.run({ prompt: 'detach' }).result()).status).toBe('completed');
    resume();
    await expect(later).resolves.toContain('extension-data');
  });

  it('can use the actual Code Mode context from a model request Hook without fabricating history', async () => {
    let called = false;
    const { session, adapter } = await fixture(
      [
        {
          id: 'hooks',
          apiVersion: '1.0',
          attachSession(value) {
            value.hooks.intercept('model.request', async (input, _call, next) => {
              expect(
                (await value.tools.check({ name: 'code_exec', arguments: {} })).available
              ).toBe(true);
              const output = await value.tools.invoke({
                name: 'code_exec',
                arguments: {
                  code: 'observe.result(await tools.read({reads:[{path:"input.txt"}]}))'
                }
              });
              expect(output.content).toContain('extension-data');
              called = true;
              return next(input);
            });
          }
        }
      ],
      answer,
      true
    );
    expect((await session.run({ prompt: 'code' }).result()).status).toBe('completed');
    expect(called).toBe(true);
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]!.messages.some((message) => message.role === 'tool')).toBe(false);
  });

  it.each([false, true])(
    'does not expose ROOT_ONLY tools to native child Session Hooks (wrapped=%s)',
    async (wrapped) => {
      let childId = '';
      let childChecked = false;
      let effects = 0;
      const { session, agent, home } = await fixture(
        [
          {
            id: 'hooks',
            apiVersion: '1.0',
            attachSession(value) {
              if (wrapped)
                value.tools.register({
                  name: 'root_probe',
                  description: 'Wrapped root tool.',
                  override: 'wrap',
                  inputSchema: { type: 'object' },
                  execute: (input, _call, next) => next(input)
                });
              value.hooks.intercept('model.request', async (input, _call, next) => {
                if (value.sessionId === childId) {
                  expect(
                    value.tools.catalog().some((ref) => ref.definition.name === 'root_probe')
                  ).toBe(false);
                  expect(
                    (await value.tools.check({ name: 'root_probe', arguments: {} })).available
                  ).toBe(false);
                  await expect(
                    value.tools.invoke({ name: 'root_probe', arguments: {} })
                  ).rejects.toThrow(/TOOL_NOT_AVAILABLE/);
                  childChecked = true;
                }
                return next(input);
              });
            }
          }
        ],
        answer,
        false,
        false,
        {
          operationTools: {
            catalog: () => [
              {
                definition: {
                  name: 'root_probe',
                  description: 'Root only',
                  agentScope: 'ROOT_ONLY',
                  inputSchema: { type: 'object' }
                },
                source: { kind: 'host', id: 'root-probe', revision: '1' },
                execute: async () => {
                  effects++;
                  return { content: 'root' };
                }
              }
            ]
          }
        }
      );
      expect((await session.run({ prompt: 'initialize' }).result()).status).toBe('completed');
      const child = await agent.createSession({
        workspace: home,
        source: {
          type: 'subagent',
          parentSessionId: session.id,
          rootSessionId: session.id,
          parentExecutionId: 'parent-execution',
          role: 'explore',
          description: 'Verify child tool restrictions'
        }
      });
      childId = child.id;
      expect((await child.run({ prompt: 'child' }).result()).status).toBe('completed');
      expect(childChecked).toBe(true);
      expect(effects).toBe(0);
    }
  );

  it('keeps a retained cell on its real captured Execution after the main request completes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cellId!: string;
    let visits = 0;
    let originalRead!: string;
    let firstExecution!: string;
    const { session } = await fixture(
      [
        {
          id: 'hooks',
          apiVersion: '1.0',
          attachSession(value) {
            value.tools.register({
              name: 'pause',
              description: 'Pause',
              inputSchema: { type: 'object' },
              parallelSafety: 'safe',
              async execute() {
                await gate;
                return { content: 'released' };
              }
            });
            value.hooks.observe('tool.attempt.completed', (fact, call) => {
              if (fact.name === 'read') originalRead = call.executionId!;
            });
            value.hooks.intercept('model.request', async (input, call, next) => {
              if (visits++ === 0) {
                firstExecution = call.executionId!;
                const result = await value.tools.invoke({
                  name: 'code_exec',
                  arguments: {
                    code: '// @options: {"yieldMs":0}\nobserve.result(await tools.pause({})); observe.result(await tools.read({reads:[{path:"input.txt"}]}));'
                  }
                });
                expect(result.data).toMatchObject({ status: 'running' });
                cellId = (result.data as { cellId: string }).cellId;
              } else {
                const result = await value.tools.invoke({
                  name: 'code_exec_wait',
                  arguments: { cellId, yieldMs: 1000 }
                });
                expect(result.data).toMatchObject({ status: 'completed' });
                expect(result.content).toContain('extension-data');
                expect(call.executionId).not.toBe(firstExecution);
              }
              return next(input);
            });
          }
        }
      ],
      answer,
      true
    );
    try {
      expect((await session.run({ prompt: 'launch' }).result()).status).toBe('completed');
      expect(cellId).toBeDefined();
      release();
      expect((await session.run({ prompt: 'wait' }).result()).status).toBe('completed');
      expect(originalRead).toBe(firstExecution);
      expect(visits).toBe(2);
    } finally {
      release();
    }
  });

  it.each(['clear', 'dispose'] as const)(
    'cancels and joins a real retained cell before Session %s finishes',
    async (action) => {
      const entered = Promise.withResolvers<void>();
      const stopped = Promise.withResolvers<void>();
      let context!: SessionExtensionContext;
      let cellId!: string;
      let launched = false;
      let cancelled = false;
      let effects = 0;
      const { agent, session, host, home } = await fixture(
        [
          {
            id: 'retained',
            apiVersion: '1.0',
            attachSession(value) {
              context = value;
              value.tools.register({
                name: 'retained_gate',
                description: 'Wait for cancellation.',
                inputSchema: { type: 'object' },
                parallelSafety: 'safe',
                async execute(_input, call) {
                  entered.resolve();
                  try {
                    await new Promise<void>((_resolve, reject) => {
                      const abort = () => {
                        cancelled = true;
                        reject(call.signal.reason);
                      };
                      call.signal.addEventListener('abort', abort, { once: true });
                      if (call.signal.aborted) abort();
                    });
                    return { content: 'unexpected completion' };
                  } finally {
                    stopped.resolve();
                  }
                }
              });
              value.tools.register({
                name: 'after_gate',
                description: 'Record an effect.',
                inputSchema: { type: 'object' },
                execute() {
                  effects++;
                  return { content: 'effect' };
                }
              });
              value.hooks.intercept('model.request', async (input, _call, next) => {
                if (!launched) {
                  launched = true;
                  const result = await value.tools.invoke({
                    name: 'code_exec',
                    arguments: {
                      code: '// @options: {"yieldMs":0}\nobserve.result(await tools.retained_gate({})); observe.result(await tools.after_gate({}));'
                    }
                  });
                  expect(result.data).toMatchObject({ status: 'running' });
                  cellId = (result.data as { cellId: string }).cellId;
                }
                return next(input);
              });
            }
          }
        ],
        answer,
        true
      );
      expect((await session.run({ prompt: 'launch' }).result()).status).toBe('completed');
      await entered.promise;
      expect((await host.listSessionResources(session.id)).codeCells).toEqual([
        expect.objectContaining({ cellId, status: 'running' })
      ]);
      const stale = context;
      if (action === 'clear') await agent.clearSession(session.id);
      else await agent.dispose();
      await stopped.promise;
      expect(cancelled).toBe(true);
      expect(effects).toBe(0);
      expect((await host.listSessionResources(session.id)).codeCells).toEqual([]);
      await expect(stale.tools.invoke({ name: 'after_gate', arguments: {} })).rejects.toThrow(
        /RETIRED/
      );
      const directory = await activeSessionDirectory(home, session.id);
      const before = await readFile(
        join(
          directory,
          (await readdir(directory)).find((name) => name.endsWith('.jsonl'))!
        ),
        'utf8'
      );
      await Promise.resolve();
      expect(
        await readFile(
          join(
            directory,
            (await readdir(directory)).find((name) => name.endsWith('.jsonl'))!
          ),
          'utf8'
        )
      ).toBe(before);
      if (action === 'clear') {
        expect((await session.run({ prompt: 'after clear' }).result()).status).toBe('completed');
        expect(context).not.toBe(stale);
        await expect(
          context.tools.invoke({ name: 'code_exec_wait', arguments: { cellId } })
        ).rejects.toThrow(/TOOL_NOT_AVAILABLE/);
        expect(effects).toBe(0);
      }
    }
  );

  it('binds retained programmatic Agent delegation to its original Execution', async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let context!: SessionExtensionContext;
    let launch = true;
    let cellId!: string;
    let childId!: string;
    let agent!: Agent;
    let rootId = '';
    const f = await fixture(
      [
        createSubagentExtension({ agent: () => agent }),
        {
          id: 'retained-native-agent',
          apiVersion: '1.0',
          attachSession(value) {
            if (value.sessionId !== rootId) return;
            context = value;
            value.tools.register({
              name: 'retained_delegate',
              description: 'Delegate after the parent request finishes.',
              inputSchema: { type: 'object' },
              parallelSafety: 'safe',
              async execute(_input, operation) {
                entered.resolve();
                await gate.promise;
                const result = await value.tools.invoke({
                  name: 'agent_start',
                  arguments: {
                    title: 'retained delegation',
                    description: 'retained delegation',
                    prompt: 'RETAINED_NATIVE_CHILD',
                    role: 'general-purpose'
                  }
                });
                const child = result.data as { agentId: string; executionId: string };
                childId = child.agentId;
                const childSession = await agent.openSession(child.agentId);
                const completion = childSession.joinExecution(child.executionId);
                if (completion) expect((await completion).status).toBe('completed');
                const history = await agent.sessionHistory(child.agentId);
                expect(history.entries).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({
                      kind: 'event',
                      event: expect.objectContaining({ type: 'execution.completed' })
                    })
                  ])
                );
                return {
                  content: 'RETAINED_AGENT_completed',
                  data: { executionId: operation.executionId }
                };
              }
            });
            value.hooks.intercept('model.request', async (input, _call, next) => {
              if (launch) {
                launch = false;
                const result = await value.tools.invoke({
                  name: 'code_exec',
                  arguments: {
                    code: '// @options: {"yieldMs":0}\nobserve.result(await tools.retained_delegate({}));'
                  }
                });
                cellId = (result.data as { cellId: string }).cellId;
                expect(result.data).toMatchObject({ status: 'running' });
              }
              return next(input);
            });
          }
        }
      ],
      answer,
      true,
      true
    );
    agent = f.agent;
    rootId = f.session.id;
    await agent.reconfigureModels({
      models: [{ ...f.adapter.configuration, subagentModel: true }]
    });
    try {
      const parent = f.session.run({ prompt: 'launch retained delegation' });
      expect(await parent.result()).toHaveProperty('status', 'completed');
      await entered.promise;
      expect(
        await f.session.run({ prompt: 'a different completed parent' }).result()
      ).toHaveProperty('status', 'completed');
      gate.resolve();
      const resource = await f.host.listSessionResources(f.session.id);
      expect(resource.codeCells).toContainEqual(
        expect.objectContaining({ cellId, executionId: parent.executionId })
      );
      let result: import('../../src/index.js').ToolExecutionResult | undefined;
      const registration = context.hooks.intercept('model.request', async (input, _call, next) => {
        result = await context.tools.invoke({
          name: 'code_exec_wait',
          arguments: { cellId, yieldMs: 1000 }
        });
        return next(input);
      });
      await f.session.run({ prompt: 'join retained delegation' }).result();
      await registration.dispose();
      expect(result?.data, JSON.stringify(result)).toMatchObject({ status: 'completed' });
      expect(childId).toEqual(expect.any(String));
      expect((await agent.getSession(childId)).source).toMatchObject({
        parentSessionId: f.session.id,
        parentExecutionId: parent.executionId
      });
    } finally {
      gate.resolve();
    }
  });

  it('defers Agent-wide replacement while a real cell retains the old generation', async () => {
    const key: ExtensionServiceKey<{ revision: string }> = {
      id: 'retained-service',
      scope: 'agent'
    };
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const contexts = new Map<string, SessionExtensionContext>();
    const attachments: string[] = [];
    const cleanups: string[] = [];
    const facts: Array<{ revision: string; executionId?: string }> = [];
    let revision = '1';
    let launch = true;
    let wait = false;
    let cellId!: string;
    const extension = (selected: string): AgentExtension => ({
      id: 'retained',
      apiVersion: '1.0',
      setup(value) {
        value.services.provide(key, { revision: selected });
        value.resources.effect(() => () => {
          cleanups.push(`agent:${selected}`);
        });
      },
      attachSession(value) {
        contexts.set(value.sessionId, value);
        attachments.push(`${value.sessionId}:${selected}`);
        value.resources.effect(() => () => {
          cleanups.push(`session:${value.sessionId}:${selected}`);
        });
        value.tools.register({
          name: 'retained_gate',
          description: 'Wait for release.',
          inputSchema: { type: 'object' },
          parallelSafety: 'safe',
          async execute() {
            entered.resolve();
            await gate.promise;
            return { content: 'released' };
          }
        });
        value.tools.register({
          name: 'generation_marker',
          description: 'Read the bound generation.',
          inputSchema: { type: 'object' },
          execute(_input, call) {
            const service = value.services.consume(key)!;
            facts.push({
              revision: service.revision,
              ...(call.executionId ? { executionId: call.executionId } : {})
            });
            return { content: `ORIGINAL_REVISION_${service.revision}` };
          }
        });
        value.hooks.intercept('model.request', async (input, _call, next) => {
          if (launch) {
            launch = false;
            const result = await value.tools.invoke({
              name: 'code_exec',
              arguments: {
                code: '// @options: {"yieldMs":0}\nobserve.result(await tools.retained_gate({})); observe.result(await tools.generation_marker({}));'
              }
            });
            cellId = (result.data as { cellId: string }).cellId;
            expect(result.data).toMatchObject({ status: 'running' });
          } else if (wait) {
            wait = false;
            const result = await value.tools.invoke({
              name: 'code_exec_wait',
              arguments: { cellId, yieldMs: 1000 }
            });
            expect(result.data).toMatchObject({ status: 'completed' });
            expect(result.content).toContain('ORIGINAL_REVISION_1');
          }
          return next(input);
        });
      }
    });
    const { agent, session, host, home } = await fixture(
      { resolve: async () => ({ revision, extensions: [extension(revision)] }) },
      answer,
      true
    );
    try {
      const first = session.run({ prompt: 'launch' });
      expect((await first.result()).status).toBe('completed');
      await entered.promise;
      const original = contexts.get(session.id)!;
      const ref = original.tools
        .catalog()
        .find((tool) => tool.definition.name === 'generation_marker')!;
      revision = '2';
      expect((await session.run({ prompt: 'update pending' }).result()).status).toBe('completed');
      const other = await agent.createSession({ workspace: home, title: 'Other retained Session' });
      expect((await other.run({ prompt: 'other pending' }).result()).status).toBe('completed');
      expect(attachments).toEqual([`${session.id}:1`, `${other.id}:1`]);
      expect(contexts.get(session.id)).toBe(original);
      expect(cleanups).toEqual([]);
      expect(agent.extensionDiagnostics()).toContainEqual(
        expect.objectContaining({ code: 'MAR_AGENT_EXTENSION_UPDATE_PENDING', revision: '2' })
      );
      gate.resolve();
      wait = true;
      expect((await session.run({ prompt: 'join retained cell' }).result()).status).toBe(
        'completed'
      );
      expect(facts).toContainEqual({ revision: '1', executionId: first.executionId });
      expect(cleanups).toEqual([]);
      expect((await session.run({ prompt: 'activate new generation' }).result()).status).toBe(
        'completed'
      );
      expect(cleanups).toEqual([`session:${session.id}:1`, `session:${other.id}:1`, 'agent:1']);
      const current = contexts.get(session.id)!;
      expect(current).not.toBe(original);
      expect(
        (await current.tools.invoke({ name: 'generation_marker', arguments: {} })).content
      ).toBe('ORIGINAL_REVISION_2');
      await expect(
        current.tools.invoke({ name: 'generation_marker', arguments: {}, ref })
      ).rejects.toThrow(/TOOL_NOT_AVAILABLE/);
      await expect(
        original.tools.invoke({ name: 'generation_marker', arguments: {} })
      ).rejects.toThrow(/RETIRED/);
      expect((await host.listSessionResources(session.id)).codeCells).toContainEqual(
        expect.objectContaining({ cellId, status: 'completed', executionId: first.executionId })
      );
      expect((await other.run({ prompt: 'attach new generation' }).result()).status).toBe(
        'completed'
      );
      expect(attachments).toEqual([
        `${session.id}:1`,
        `${other.id}:1`,
        `${session.id}:2`,
        `${other.id}:2`
      ]);
    } finally {
      gate.resolve();
    }
  });

  it('uses the real builtin context in an early standalone compaction request', async () => {
    let compactChecked = false;
    const { session } = await fixture(
      [
        {
          id: 'hooks',
          apiVersion: '1.0',
          attachSession(value) {
            value.hooks.intercept('model.request', async (input, call, next) => {
              if (input.toolChoice === 'none') {
                expect(
                  (await value.tools.check({ name: 'todo_read', arguments: {} })).available
                ).toBe(true);
                expect(
                  (await value.tools.invoke({ name: 'todo_read', arguments: {} })).data
                ).toMatchObject({ items: [] });
                expect(call.executionId).toBeDefined();
                compactChecked = true;
              }
              return next(input);
            });
          }
        }
      ],
      answer
    );
    expect((await session.run({ prompt: 'initialize' }).result()).status).toBe('completed');
    expect((await session.compact({ prompt: 'summarize' }).result()).status).toBe('completed');
    expect(compactChecked).toBe(true);
  });

  it('binds the real builtin context before an initial automatic compaction request', async () => {
    let compacts = 0;
    const { session, adapter } = await fixture(
      [
        {
          id: 'auto-hooks',
          apiVersion: '1.0',
          attachSession(value) {
            value.hooks.intercept('model.request', async (input, call, next) => {
              if (input.toolChoice === 'none') {
                compacts++;
                expect(
                  (await value.tools.check({ name: 'todo_read', arguments: {} })).available
                ).toBe(true);
                const result = await value.tools.invoke({ name: 'todo_read', arguments: {} });
                expect(result.data).toMatchObject({ revision: 0, items: [] });
                expect(call.executionId).toBeDefined();
              }
              return next(input);
            });
          }
        }
      ],
      (_request, index) =>
        index === 0
          ? [
              ...answer().slice(0, 1),
              {
                type: 'usage',
                usage: { inputTokens: 190_000, contextInputTokens: 190_000, outputTokens: 1 }
              },
              { type: 'completed', reason: 'completed' }
            ]
          : answer()
    );
    expect((await session.run({ prompt: 'initialize usage' }).result()).status).toBe('completed');
    const result = await session.run({ prompt: 'automatic compact' }).result();
    expect(compacts).toBe(1);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'completed' });
    expect(adapter.requests).toHaveLength(3);
  });

  it('does not revive a completed Execution through an unretained captured dispatcher', async () => {
    let stale!: NonNullable<
      import('../../src/tools/contracts.js').ToolExecutionContext['codeMode']
    >['invoke'];
    const { session, host } = await fixture(
      [],
      (_request, index) => (index === 0 ? call('capture', {}) : answer()),
      false,
      false,
      {
        extensions: {
          tools: [{ name: 'capture', description: 'Capture', inputSchema: { type: 'object' } }],
          executeTool: async (_input, context) => {
            stale = context.codeMode!.invoke;
            return { content: 'captured' };
          }
        }
      }
    );
    expect((await session.run({ prompt: 'capture' }).result()).status).toBe('completed');
    const events = host.events.length;
    await expect(
      stale(
        { name: 'read', arguments: { reads: [{ path: 'input.txt' }] } },
        new AbortController().signal
      )
    ).rejects.toThrow(/TOOL_NOT_AVAILABLE/);
    expect(host.events).toHaveLength(events);
  });

  it('binds retained authority to its own dispatcher and revokes it on release', async () => {
    type Dispatch = NonNullable<
      import('../../src/tools/contracts.js').ToolExecutionContext['codeMode']
    >['invoke'];
    const dispatchers: Dispatch[] = [];
    let release!: () => Promise<void>;
    const { session, host } = await fixture(
      [],
      (_request, index) => (index < 2 ? call('capture', { retained: index === 0 }) : answer()),
      false,
      false,
      {
        extensions: {
          tools: [{ name: 'capture', description: 'Capture', inputSchema: { type: 'object' } }],
          executeTool: async (input, context) => {
            dispatchers.push(context.codeMode!.invoke);
            if ((input.arguments as { retained: boolean }).retained)
              release = await context.codeMode!.retainSession!();
            return { content: 'captured' };
          }
        }
      }
    );
    const cleanup = host.disposeSessionResources.bind(host);
    host.disposeSessionResources = async (id) => {
      await release?.();
      await cleanup(id);
    };
    try {
      expect((await session.run({ prompt: 'capture both' }).result()).status).toBe('completed');
      const input = { name: 'read', arguments: { reads: [{ path: 'input.txt' }] } };
      expect((await dispatchers[0]!(input, new AbortController().signal)).content).toContain(
        'extension-data'
      );
      const events = host.events.length;
      await expect(dispatchers[1]!(input, new AbortController().signal)).rejects.toThrow(
        /TOOL_NOT_AVAILABLE/
      );
      expect(host.events).toHaveLength(events);
      await release();
      await expect(dispatchers[0]!(input, new AbortController().signal)).rejects.toThrow(
        /TOOL_NOT_AVAILABLE/
      );
      expect(host.events).toHaveLength(events);
    } finally {
      await release?.();
    }
  });

  it('rejects queued dispatcher events and leaves cleared history unchanged', async () => {
    let stale!: NonNullable<
      import('../../src/tools/contracts.js').ToolExecutionContext['codeMode']
    >['invoke'];
    let reads = 0;
    let releaseDispatch!: () => Promise<void>;
    const { agent, session, host, home } = await fixture(
      [],
      (_request, index) => (index === 0 ? call('capture', {}) : answer()),
      false,
      false,
      {
        beforeToolExecute(input) {
          if (input.name === 'read') reads++;
        },
        extensions: {
          tools: [{ name: 'capture', description: 'Capture', inputSchema: { type: 'object' } }],
          executeTool: async (_input, context) => {
            stale = context.codeMode!.invoke;
            releaseDispatch = await context.codeMode!.retainSession!();
            return { content: 'captured' };
          }
        }
      }
    );
    expect((await session.run({ prompt: 'capture' }).result()).status).toBe('completed');
    const cleanup = host.disposeSessionResources.bind(host);
    host.disposeSessionResources = async (id) => {
      await releaseDispatch();
      await cleanup(id);
    };
    let release!: () => void;
    let reached!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const emit = host.emit.bind(host);
    host.emit = async (event) => {
      emit(event);
      if (event.type === 'tool.started' && event.toolName === 'read') {
        reached();
        await blocked;
      }
    };
    const pending = [
      stale(
        { name: 'read', arguments: { reads: [{ path: 'input.txt' }] } },
        new AbortController().signal
      )
    ];
    await started;
    pending.push(
      stale(
        { name: 'read', arguments: { reads: [{ path: 'input.txt' }] } },
        new AbortController().signal
      )
    );
    const settled = Promise.allSettled(pending);
    try {
      await agent.clearSession(session.id);
      const directory = join(home, '.mar', 'agent', 'sessions', session.id);
      const history = async () =>
        Promise.all(
          (await readdir(directory))
            .filter((name) => name.endsWith('.jsonl'))
            .sort()
            .map(async (name) => [name, await readFile(join(directory, name), 'utf8')])
        );
      const before = await history();
      const events = host.events.length;
      release();
      const outcomes = await settled;
      expect(
        outcomes.every(
          (outcome) =>
            outcome.status === 'rejected' && outcome.reason.code === 'MAR_AGENT_TOOL_NOT_AVAILABLE'
        )
      ).toBe(true);
      expect(reads).toBe(0);
      expect(host.events).toHaveLength(events);
      expect(await history()).toEqual(before);
    } finally {
      release();
      await settled;
      await releaseDispatch();
    }
  });

  it.each(['clear', 'dispose'] as const)(
    'rejects a captured Code Mode dispatcher before effects or history writes after %s',
    async (retirement) => {
      let stale!: NonNullable<
        import('../../src/tools/contracts.js').ToolExecutionContext['codeMode']
      >['invoke'];
      let reads = 0;
      const { agent, session, home, host } = await fixture(
        [],
        (_request, index) => (index === 0 ? call('capture', {}) : answer()),
        false,
        false,
        {
          beforeToolExecute(input) {
            if (input.name === 'read') reads++;
          },
          extensions: {
            tools: [{ name: 'capture', description: 'Capture', inputSchema: { type: 'object' } }],
            executeTool: async (_input, context) => {
              stale = context.codeMode!.invoke;
              return { content: 'captured' };
            }
          }
        }
      );
      expect((await session.run({ prompt: 'capture' }).result()).status).toBe('completed');
      if (retirement === 'clear') await agent.clearSession(session.id);
      else await agent.dispose();
      const directory = join(home, '.mar', 'agent', 'sessions', session.id);
      const history = async () =>
        Promise.all(
          (await readdir(directory))
            .filter((name) => name.endsWith('.jsonl'))
            .sort()
            .map(async (name) => [name, await readFile(join(directory, name), 'utf8')])
        );
      const before = await history();
      const events = host.events.length;
      await expect(
        stale(
          { name: 'read', arguments: { reads: [{ path: 'input.txt' }] } },
          new AbortController().signal
        )
      ).rejects.toThrow(/TOOL_NOT_AVAILABLE|RETIRED/);
      expect(reads).toBe(0);
      expect(host.events).toHaveLength(events);
      expect(await history()).toEqual(before);
      if (retirement === 'clear') {
        expect((await session.run({ prompt: 'new epoch' }).result()).status).toBe('completed');
        await expect(
          stale(
            { name: 'read', arguments: { reads: [{ path: 'input.txt' }] } },
            new AbortController().signal
          )
        ).rejects.toThrow(/TOOL_NOT_AVAILABLE|RETIRED/);
        expect(reads).toBe(0);
      }
    }
  );
});
